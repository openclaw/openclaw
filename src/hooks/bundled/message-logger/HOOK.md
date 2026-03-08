---
name: message-logger
description: "Save all chat conversations as organized Markdown files in the workspace"
homepage: https://docs.openclaw.ai/automation/hooks#message-logger
metadata:
  {
    "openclaw":
      {
        "emoji": "\uD83D\uDCDD",
        "events": ["message:received", "message:sent"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Message Logger Hook

Saves all chat conversations (inbound + outbound) as organized Markdown files in the workspace. Each contact or group gets its own folder with daily Markdown files and a `media/` sub-directory for attachments.

## What It Does

Every time a message is received or sent:

1. **Resolves the contact** - Uses sender metadata, contacts-map.json, or falls back to phone number
2. **Auto-discovers contacts** - Detects sender name from any channel (WhatsApp, Telegram, Discord, Signal, iMessage, Slack) and auto-populates contacts-map.json
3. **Appends to daily log** - Writes to `chat-history/{contact-slug}/{YYYY-MM-DD}.md`
4. **Copies media** - Images, audio, video, documents are copied to `chat-history/{contact-slug}/media/`
5. **Handles groups** - Group chats get their own folder with per-sender labels

## Output Format

```markdown
# Chat: Alice (5511999990000)

## 2026-02-24

← 08:30 | Hello! How are you?
→ 08:31 | Hi Alice! I'm doing well, how can I help?
← 08:35 | 🎤 [audio] > Hey, I need you to check that report...
← 08:40 | 📎 [image: media/2026-02-24-084000-0.jpg]
→ 08:41 | Checked! The report looks correct.
```

## Auto-Discovery

The hook automatically detects contact names from any channel's metadata:

| Channel  | Name field                 | Example       |
| -------- | -------------------------- | ------------- |
| WhatsApp | `senderName`               | "Alice Smith" |
| Telegram | `first_name` + `last_name` | "Alice Smith" |
| Discord  | `displayName` / `username` | "alice.smith" |
| Signal   | `profileName`              | "Alice"       |
| iMessage | macOS contact name         | "Alice Smith" |
| Slack    | `real_name`                | "Alice Smith" |

Discovered contacts are saved to `<workspace>/memory/contacts-map.json`.

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

## Configuration

| Option      | Type   | Default                    | Description             |
| ----------- | ------ | -------------------------- | ----------------------- |
| `outputDir` | string | `<workspace>/chat-history` | Custom output directory |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "message-logger": {
          "enabled": true,
          "outputDir": "/custom/path/chat-history"
        }
      }
    }
  }
}
```

## Migration Tool

When contacts-map.json is updated, use the migration tool to rename old phone-number folders to named slugs:

```typescript
import { migrateNumberedFolders } from "./migrate.js";

// Dry run
const results = await migrateNumberedFolders({ dryRun: true });

// Actual migration
const results = await migrateNumberedFolders();
```

## Disabling

```bash
openclaw hooks disable message-logger
```

Or via config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "message-logger": { "enabled": false }
      }
    }
  }
}
```
