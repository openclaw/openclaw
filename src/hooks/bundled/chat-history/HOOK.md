---
name: chat-history
description: "Log incoming messages to flat markdown files for grep-based retrieval"
homepage: https://docs.evox.sh/automation/hooks#chat-history
metadata:
  {
    "openclaw":
      {
        "emoji": "📜",
        "events": ["message:received"],
        "requires": { "config": ["chatHistory.enabled"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with EVOX.sh" }],
      },
  }
---

# Chat History Hook

Logs incoming messages to flat markdown files for grep-based retrieval. Follows Viktor's pattern: real-time capture, simple file structure, grep for search.

## What It Does

When a message is received:

1. **Checks config** - Only logs if `chatHistory.enabled: true`
2. **Formats message** - Creates timestamped markdown entry with sender info
3. **Appends to file** - Writes to `knowledge/chat-history/{channel}/{YYYY-MM}.md`
4. **Per-group split** - Optionally writes to per-group files

## Output Format

Messages are logged in markdown format:

```markdown
[2026-03-25T12:30:45 PST] **son piaz** (uid:498509454) in **CAL Community** (gid:-1002258503151):
Chào mọi người

[2026-03-25T12:31:02 PST] **Giang VT** (uid:123456789) in **CAL Community** (gid:-1002258503151):
[reply] Chào anh!
```

## File Structure

```
workspace/knowledge/chat-history/
└── telegram/
    ├── 2026-03.md           # All messages (monthly)
    └── groups/
        └── -1002258503151/  # Per-group (if splitByGroup: true)
            └── 2026-03.md
```

## Configuration

Enable in `evox.json`:

```json
{
  "chatHistory": {
    "enabled": true,
    "channels": {
      "telegram": true,
      "slack": true,
      "discord": false
    },
    "storage": {
      "path": "knowledge/chat-history",
      "splitByGroup": true,
      "splitByMonth": true
    },
    "format": {
      "includeUserId": true,
      "includeGroupId": true,
      "includeGroupName": true,
      "timezone": "America/Los_Angeles",
      "includeReplyContext": true
    }
  }
}
```

### Config Options

| Option                                   | Type    | Default                  | Description                 |
| ---------------------------------------- | ------- | ------------------------ | --------------------------- |
| `chatHistory.enabled`                    | boolean | false                    | Enable chat history logging |
| `chatHistory.channels.*`                 | boolean | true                     | Per-channel enable/disable  |
| `chatHistory.storage.path`               | string  | "knowledge/chat-history" | Base path for log files     |
| `chatHistory.storage.splitByGroup`       | boolean | false                    | Create per-group files      |
| `chatHistory.storage.splitByMonth`       | boolean | true                     | Split by month              |
| `chatHistory.format.includeUserId`       | boolean | true                     | Include user ID             |
| `chatHistory.format.includeGroupId`      | boolean | true                     | Include group ID            |
| `chatHistory.format.includeGroupName`    | boolean | true                     | Include group name          |
| `chatHistory.format.timezone`            | string  | "UTC"                    | Timezone for timestamps     |
| `chatHistory.format.includeReplyContext` | boolean | true                     | Mark replies with [reply]   |

## Searching History

Use grep or the `search-chat.sh` tool:

```bash
# Search all history
grep -i "keyword" knowledge/chat-history/telegram/*.md

# Search specific month
grep -i "keyword" knowledge/chat-history/telegram/2026-03.md

# Search specific group
grep -i "keyword" knowledge/chat-history/telegram/groups/-1002258503151/*.md
```

## Why Flat Files?

- **Simple**: No database, no dependencies
- **Fast**: grep scales to 100MB+ files
- **Portable**: Copy/backup/restore easily
- **Transparent**: Human-readable format
- **Viktor-proven**: "tìm kiếm giỏi, không phải nhớ giỏi"

## Disabling

```bash
evox hooks disable chat-history
```

Or set in config:

```json
{
  "chatHistory": {
    "enabled": false
  }
}
```
