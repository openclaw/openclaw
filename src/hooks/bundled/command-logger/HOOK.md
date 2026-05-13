---
name: command-logger
description: "Log all command events to the shared SQLite state database"
homepage: https://docs.openclaw.ai/automation/hooks#command-logger
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["command"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Command Logger Hook

Logs all command events (`/new`, `/reset`, `/stop`, etc.) to the shared SQLite state database for debugging and monitoring purposes.

## What It Does

Every time you issue a command to the agent:

1. **Captures event details** - Command action, timestamp, session key, sender ID, source
2. **Stores in SQLite** - Inserts a row into `command_log_entries` in `state/openclaw.sqlite`
3. **Silent operation** - Runs in the background without user notifications

## Output Format

Log entries are stored as queryable SQLite columns with the original JSON payload in `entry_json`:

```json
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

## Use Cases

- **Debugging**: Track when commands were issued and from which source
- **Auditing**: Monitor command usage across different channels
- **Analytics**: Analyze command patterns and frequency
- **Troubleshooting**: Investigate issues by reviewing command history

## Storage Location

`~/.openclaw/state/openclaw.sqlite`, table `command_log_entries`.

## Requirements

No requirements - this hook works out of the box on all platforms.

## Configuration

No configuration needed. The hook automatically:

- Creates the shared SQLite database if it doesn't exist
- Appends a command-log row without overwriting older entries
- Handles errors silently without disrupting command execution

## Disabling

To disable this hook:

```bash
openclaw hooks disable command-logger
```

Or via config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

## Viewing Logs

View recent commands:

```bash
sqlite3 ~/.openclaw/state/openclaw.sqlite 'select datetime(timestamp_ms / 1000, "unixepoch"), action, session_key, sender_id, source from command_log_entries order by timestamp_ms desc limit 20;'
```

Pretty-print with jq:

```bash
sqlite3 -json ~/.openclaw/state/openclaw.sqlite 'select entry_json from command_log_entries order by timestamp_ms desc limit 20;' | jq .
```

Filter by action:

```bash
sqlite3 ~/.openclaw/state/openclaw.sqlite 'select entry_json from command_log_entries where action = "new" order by timestamp_ms desc;'
```
