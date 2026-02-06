#!/bin/bash
# Start Clawdbot Google Chat with Tailscale Funnel
# Runs at login via LaunchAgent

# Set PATH for launchd (which has minimal environment)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/Library/pnpm:$PATH"

cd "$(dirname "$0")"

LOG_FILE="/tmp/googlechat-webhook.log"

echo "$(date): Starting Clawdbot GChat..." >> "$LOG_FILE"

# Kill any existing webhook server
pkill -f "run-webhook" 2>/dev/null
sleep 1

# Start webhook server
nohup npx tsx src/googlechat/run-webhook.ts >> "$LOG_FILE" 2>&1 &
sleep 3

# Ensure Tailscale Funnel is running on the right port
tailscale funnel --bg 18793 >> "$LOG_FILE" 2>&1

echo "$(date): GChat webhook started on port 18793" >> "$LOG_FILE"
echo "$(date): Funnel: https://justins-laptop.tail73ba30.ts.net/webhook/googlechat" >> "$LOG_FILE"
