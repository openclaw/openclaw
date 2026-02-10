---（轉為繁體中文）
name: command-logger（轉為繁體中文）
description: "Log all command events to a centralized audit file"（轉為繁體中文）
homepage: https://docs.openclaw.ai/hooks#command-logger（轉為繁體中文）
metadata:（轉為繁體中文）
  {（轉為繁體中文）
    "openclaw":（轉為繁體中文）
      {（轉為繁體中文）
        "emoji": "📝",（轉為繁體中文）
        "events": ["command"],（轉為繁體中文）
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],（轉為繁體中文）
      },（轉為繁體中文）
  }（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
# Command Logger Hook（轉為繁體中文）
（轉為繁體中文）
Logs all command events (`/new`, `/reset`, `/stop`, etc.) to a centralized audit log file for debugging and monitoring purposes.（轉為繁體中文）
（轉為繁體中文）
## What It Does（轉為繁體中文）
（轉為繁體中文）
Every time you issue a command to the agent:（轉為繁體中文）
（轉為繁體中文）
1. **Captures event details** - Command action, timestamp, session key, sender ID, source（轉為繁體中文）
2. **Appends to log file** - Writes a JSON line to `~/.openclaw/logs/commands.log`（轉為繁體中文）
3. **Silent operation** - Runs in the background without user notifications（轉為繁體中文）
（轉為繁體中文）
## Output Format（轉為繁體中文）
（轉為繁體中文）
Log entries are written in JSONL (JSON Lines) format:（轉為繁體中文）
（轉為繁體中文）
```json（轉為繁體中文）
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}（轉為繁體中文）
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Use Cases（轉為繁體中文）
（轉為繁體中文）
- **Debugging**: Track when commands were issued and from which source（轉為繁體中文）
- **Auditing**: Monitor command usage across different channels（轉為繁體中文）
- **Analytics**: Analyze command patterns and frequency（轉為繁體中文）
- **Troubleshooting**: Investigate issues by reviewing command history（轉為繁體中文）
（轉為繁體中文）
## Log File Location（轉為繁體中文）
（轉為繁體中文）
`~/.openclaw/logs/commands.log`（轉為繁體中文）
（轉為繁體中文）
## Requirements（轉為繁體中文）
（轉為繁體中文）
No requirements - this hook works out of the box on all platforms.（轉為繁體中文）
（轉為繁體中文）
## Configuration（轉為繁體中文）
（轉為繁體中文）
No configuration needed. The hook automatically:（轉為繁體中文）
（轉為繁體中文）
- Creates the log directory if it doesn't exist（轉為繁體中文）
- Appends to the log file (doesn't overwrite)（轉為繁體中文）
- Handles errors silently without disrupting command execution（轉為繁體中文）
（轉為繁體中文）
## Disabling（轉為繁體中文）
（轉為繁體中文）
To disable this hook:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks disable command-logger（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Or via config:（轉為繁體中文）
（轉為繁體中文）
```json（轉為繁體中文）
{（轉為繁體中文）
  "hooks": {（轉為繁體中文）
    "internal": {（轉為繁體中文）
      "entries": {（轉為繁體中文）
        "command-logger": { "enabled": false }（轉為繁體中文）
      }（轉為繁體中文）
    }（轉為繁體中文）
  }（轉為繁體中文）
}（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Log Rotation（轉為繁體中文）
（轉為繁體中文）
The hook does not automatically rotate logs. To manage log size, you can:（轉為繁體中文）
（轉為繁體中文）
1. **Manual rotation**:（轉為繁體中文）
（轉為繁體中文）
   ```bash（轉為繁體中文）
   mv ~/.openclaw/logs/commands.log ~/.openclaw/logs/commands.log.old（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
2. **Use logrotate** (Linux):（轉為繁體中文）
   Create `/etc/logrotate.d/openclaw`:（轉為繁體中文）
   ```（轉為繁體中文）
   /home/username/.openclaw/logs/commands.log {（轉為繁體中文）
       weekly（轉為繁體中文）
       rotate 4（轉為繁體中文）
       compress（轉為繁體中文）
       missingok（轉為繁體中文）
       notifempty（轉為繁體中文）
   }（轉為繁體中文）
   ```（轉為繁體中文）
（轉為繁體中文）
## Viewing Logs（轉為繁體中文）
（轉為繁體中文）
View recent commands:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
tail -n 20 ~/.openclaw/logs/commands.log（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Pretty-print with jq:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
cat ~/.openclaw/logs/commands.log | jq .（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Filter by action:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .（轉為繁體中文）
```（轉為繁體中文）
