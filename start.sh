#!/bin/bash
mkdir -p /home/node/.openclaw
cat > /home/node/.openclaw/config.json << EOF
{
  "channels": {
    "discord": {
      "token": "$DISCORD_TOKEN",
      "dmPolicy": "open"
    }
  },
  "models": {
    "default": "deepseek/deepseek-chat"
  },
  "keys": {
    "deepseek": "$DEEPSEEK_API_KEY"
  }
}
EOF
echo "✅ Config written!"
echo "📄 Config contents:"
cat /home/node/.openclaw/config.json
node openclaw.mjs gateway --allow-unconfigured
