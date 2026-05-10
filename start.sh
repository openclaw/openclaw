#!/bin/bash
echo "🔍 Checking environment variables..."
echo "DISCORD_TOKEN length: ${#DISCORD_TOKEN}"
echo "DEEPSEEK_API_KEY length: ${#DEEPSEEK_API_KEY}"

mkdir -p /home/node/.openclaw

cat > /home/node/.openclaw/config.json << ENDOFCONFIG
{
  "channels": {
    "discord": {
      "token": "${DISCORD_TOKEN}",
      "dmPolicy": "open"
    }
  },
  "models": {
    "default": "deepseek/deepseek-chat"
  },
  "keys": {
    "deepseek": "${DEEPSEEK_API_KEY}"
  }
}
ENDOFCONFIG

echo "✅ Config written!"
node openclaw.mjs gateway --allow-unconfigured
