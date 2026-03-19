---
name: mail-buttons
description: "Automatically add interactive Gmail action buttons to outbound messages containing mail thread IDs."
homepage: https://docs.openclaw.ai/automation/hooks#mail-buttons
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "events": ["message_sending"],
        "requires": { "bins": ["gog"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Mail Buttons Hook

Automatically adds interactive buttons (Archive, Reply, Delete, etc.) to your outgoing messages when they refer to a Gmail thread.

## How It Works

This hook listens for the `message_sending` event. If it detects a Gmail thread ID pattern in the message text, it automatically attaches interactive buttons based on your configuration.

## Features

- **Automatic Detection**: Recognizes Gmail thread IDs like `19d05a032de0fce7`.
- **Customizable Buttons**: Configure which actions appear (Archive, Delete, Reply, Star, etc.).
- **One-Tap Actions**: Perform Gmail operations directly from the chat interface.

## Requirements

- **Binary**: `gog` (Google Workspace CLI) must be installed on your system.

## Configuration

You can customize the buttons in your `openclaw.json` config file:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "mail-buttons": {
          "enabled": true,
          "buttons": [
            { "text": "📥 Archive", "action": "archive" },
            { "text": "✏️ Reply", "action": "reply" },
            { "text": "🗑 Delete", "action": "delete" }
          ]
        }
      }
    }
  }
}
```

## Disabling

To disable this hook:

```bash
openclaw hooks disable mail-buttons
```
