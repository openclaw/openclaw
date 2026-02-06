#!/bin/bash
# Start Clawdbot Google Chat Integration
# Run this script after restarting your computer

cd "$(dirname "$0")"

CONFIG_FILE="$HOME/.clawdbot-googlechat-url"

echo ""
echo "🦞 Starting Clawdbot Google Chat..."
echo ""

# Kill any existing processes
pkill -f "ngrok http 18793" 2>/dev/null
pkill -f "run-webhook" 2>/dev/null
sleep 1

# Start ngrok in background
echo "1. Starting ngrok tunnel..."
ngrok http 18793 > /tmp/ngrok.log 2>&1 &
sleep 4

# Get the ngrok URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$NGROK_URL" ]; then
    echo "   ❌ ERROR: ngrok failed to start. Check your internet connection."
    exit 1
fi

WEBHOOK_URL="${NGROK_URL}/webhook/googlechat"
echo "   ✓ Tunnel active"

# Check if URL changed
LAST_URL=$(cat "$CONFIG_FILE" 2>/dev/null)

if [ "$NGROK_URL" != "$LAST_URL" ]; then
    echo ""
    echo "=========================================="
    echo "⚠️  NGROK URL CHANGED!"
    echo "=========================================="
    echo ""
    echo "New webhook URL:"
    echo "$WEBHOOK_URL"
    echo ""
    echo "👉 UPDATE GOOGLE CHAT NOW:"
    echo "   1. Go to: https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat"
    echo "   2. Click Clawdbot"
    echo "   3. Change HTTP endpoint URL to the new URL above"
    echo "   4. Save"
    echo ""
    read -p "Press ENTER after you've updated Google Chat..."

    # Save the new URL
    echo "$NGROK_URL" > "$CONFIG_FILE"
else
    echo "   ✓ Same URL as before - no Google Chat update needed!"
fi

# Start webhook server
echo ""
echo "2. Starting webhook server..."
npx tsx src/googlechat/run-webhook.ts > /tmp/googlechat-webhook.log 2>&1 &
sleep 3

# Verify webhook is running
if lsof -i :18793 > /dev/null 2>&1; then
    echo "   ✓ Webhook running"
else
    echo "   ❌ ERROR: Webhook failed to start"
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ Clawdbot Google Chat is READY!"
echo "=========================================="
echo ""
echo "Webhook URL: $WEBHOOK_URL"
echo ""
echo "Logs:  tail -f /tmp/googlechat-webhook.log"
echo "Stop:  pkill -f ngrok && pkill -f run-webhook"
echo ""
