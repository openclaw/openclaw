# Examples

Real-world examples of using the Channel Diagnostics Toolkit.

## Example 1: Diagnosing WhatsApp Echo Issues

### Problem

Messages sent by the bot are being echoed back in group chats.

### Solution Steps

```bash
# 1. Check channel health
$ node --import tsx tools/channel-diagnostics/health-check.ts

🟡 DEGRADED (1):
   • WhatsApp
     ⚠️  Known issues for whatsapp
     💡 Recent fixes: Group message echo (#53624)

# 2. Check error patterns
$ node --import tsx tools/channel-diagnostics/error-analyzer.ts

1. Group message echo
   📊 Occurrences: 1
   📱 Channels: whatsapp
   💡 Suggested fix: Upgrade to 2026.3.23+ which includes echo suppression fix

# 3. Verify version
$ openclaw --version
2026.3.22  # Need to upgrade!

# 4. Upgrade
$ npm install -g openclaw@latest

# 5. Verify fix
$ node --import tsx tools/channel-diagnostics/health-check.ts
✅ All channels appear healthy!
```

## Example 2: Setting Up a New Channel

### Problem

Want to add Telegram support but not sure if it's configured correctly.

### Solution Steps

```bash
# 1. Check if Telegram is available
$ node --import tsx tools/channel-diagnostics/health-check.ts | grep -i telegram

❓ UNKNOWN (1):
   • Telegram
     ℹ️  Channel 'telegram' is available but not configured
     💡 Run: openclaw channels add telegram

# 2. Add the channel
$ openclaw channels add telegram
# Follow the prompts to configure

# 3. Verify configuration
$ node --import tsx tools/channel-diagnostics/health-check.ts | grep -i telegram

✅ HEALTHY (1):
   • Telegram

# 4. Generate tests
$ node --import tsx tools/channel-diagnostics/test-generator.ts --channel telegram

✅ Test suite generated successfully!
📄 Files created:
   • tools/channel-diagnostics/generated/telegram.test.ts
   • tools/channel-diagnostics/generated/telegram-test-plan.md

# 5. Run tests
$ pnpm test:extension telegram
```

## Example 3: Debugging Connection Issues

### Problem

Discord bot keeps disconnecting and reconnecting.

### Solution Steps

```bash
# 1. Use interactive assistant
$ node --import tsx tools/channel-diagnostics/debug-assistant.ts

Which channel are you having issues with? discord

What type of issue are you experiencing?
  1. Connection Issues
  2. Message Delivery
  3. Thread Routing
  4. Authentication
  5. Performance
  6. Other

Select (1-6): 1

Describe the symptoms (one per line, empty line to finish):
  • Bot disconnects every few minutes
  • Reconnection takes 30+ seconds
  •

💡 Suggested Solutions:
   1. Check network connectivity
   2. Verify credentials are correct
   3. Check if service is down: https://status.openclaw.ai
   4. Review recent changelog for connection fixes
   5. Run: openclaw channels status --probe

🔧 Diagnostic Commands:
   $ openclaw channels status --probe
   $ openclaw gateway status --deep
   $ openclaw doctor

# 2. Run diagnostic commands
$ openclaw channels status --probe

Discord: ✅ Connected
  Last message: 2 minutes ago
  Uptime: 45 minutes
  ⚠️  Warning: 3 reconnections in last hour

# 3. Check logs
$ openclaw logs --channel discord --tail 50

[ERROR] Discord: Rate limit exceeded
[INFO] Discord: Backing off for 30 seconds
[INFO] Discord: Reconnecting...

# 4. Solution: Rate limiting issue
# Adjust message rate in config
$ openclaw config set channels.discord.rateLimit.messages 5
$ openclaw config set channels.discord.rateLimit.perSeconds 1
```

## Example 4: Pre-PR Health Check

### Problem

Want to ensure all channels are healthy before submitting a PR.

### Solution Steps

```bash
# 1. Run full health check
$ node --import tsx tools/channel-diagnostics/health-check.ts

📊 Summary:
   Total Channels: 82
   ✅ Healthy: 75
   🟡 Degraded: 5
   🔴 Down: 2

# 2. Check error patterns
$ node --import tsx tools/channel-diagnostics/error-analyzer.ts

🔍 Found 3 error pattern(s):
...

# 3. Run tests
$ pnpm test

# 4. Run channel-specific tests
$ pnpm test:channels

# 5. Run contract tests
$ pnpm test:contracts

# 6. All green? Ready to submit!
$ git push origin feature/my-channel-fix
```

## Example 5: Monitoring Production

### Problem

Want to monitor channel health in production.

### Solution Steps

```bash
# 1. Create monitoring script
$ cat > scripts/monitor-channels.sh << 'EOF'
#!/bin/bash
# Run health check and send alerts if issues found

cd /path/to/openclaw
node --import tsx tools/channel-diagnostics/health-check.ts > /tmp/health-check.log 2>&1

if [ $? -ne 0 ]; then
  # Send alert (example: email, Slack, etc.)
  cat /tmp/health-check.log | mail -s "OpenClaw Health Check Failed" admin@example.com
fi
EOF

$ chmod +x scripts/monitor-channels.sh

# 2. Add to cron (run every hour)
$ crontab -e
0 * * * * /path/to/openclaw/scripts/monitor-channels.sh

# 3. Or use OpenClaw's built-in cron
$ openclaw cron add \
  --name "Channel Health Check" \
  --every "1h" \
  --command "node --import tsx tools/channel-diagnostics/health-check.ts"
```

## Example 6: Bulk Channel Testing

### Problem

Want to generate tests for all configured channels.

### Solution Steps

```bash
# 1. Get list of configured channels
$ openclaw channels list --json | jq -r '.[].id' > /tmp/channels.txt

# 2. Generate tests for each
$ while read channel; do
    echo "Generating tests for $channel..."
    node --import tsx tools/channel-diagnostics/test-generator.ts --channel "$channel"
  done < /tmp/channels.txt

# 3. Review generated tests
$ ls -la tools/channel-diagnostics/generated/

# 4. Move to appropriate locations
$ for file in tools/channel-diagnostics/generated/*.test.ts; do
    channel=$(basename "$file" .test.ts)
    mv "$file" "extensions/$channel/src/$channel.health.test.ts"
  done

# 5. Run all tests
$ pnpm test:extensions
```

## Tips and Tricks

### Tip 1: JSON Output for Automation

```bash
# Health check with JSON output (future feature)
$ node --import tsx tools/channel-diagnostics/health-check.ts --json > health.json

# Parse with jq
$ cat health.json | jq '.channels[] | select(.status == "down")'
```

### Tip 2: Filter by Channel

```bash
# Check specific channel only
$ node --import tsx tools/channel-diagnostics/health-check.ts | grep -A 5 "telegram"
```

### Tip 3: Continuous Monitoring

```bash
# Watch mode (run every 30 seconds)
$ watch -n 30 'node --import tsx tools/channel-diagnostics/health-check.ts'
```

### Tip 4: Export Reports

```bash
# Save report with timestamp
$ node --import tsx tools/channel-diagnostics/health-check.ts > "health-$(date +%Y%m%d-%H%M%S).log"
```

## Common Issues and Solutions

### Issue: "Config file not found"

**Solution**: Run `openclaw onboard` first or check your working directory.

### Issue: "Channel not found in extensions/"

**Solution**: The channel plugin may not be installed. Check `extensions/` directory.

### Issue: "Permission denied"

**Solution**: Check file permissions on `~/.openclaw/` directory.

### Issue: "Module not found"

**Solution**: Run `pnpm install` to ensure all dependencies are installed.

## Next Steps

- Read the [QUICKSTART.md](./QUICKSTART.md) for basic usage
- Check [README.md](./README.md) for detailed documentation
- Join [Discord](https://discord.gg/clawd) for community support
