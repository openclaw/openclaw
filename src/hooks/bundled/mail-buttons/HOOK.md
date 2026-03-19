---
name: mail-buttons
description: "Automatically add a Next button to outbound messages containing Gmail thread IDs."
homepage: https://docs.openclaw.ai/automation/hooks#mail-buttons
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "events": ["message:sending"],
        "requires": { "bins": ["gog"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Mail Buttons Hook

Automatically adds a Next button to your outgoing messages when they refer to a Gmail thread.

## How It Works

This hook listens for the `message:sending` event. If it detects a Gmail thread ID pattern in the message text, it automatically attaches a Next button based on your configuration.

## Features

- **Automatic Detection**: Recognizes Gmail thread IDs like `19d05a032de0fce7`.
- **Single-Step Triage**: Mark the current thread as read and jump to the next unread thread.

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
          "buttons": [{ "text": "➡️ Next", "action": "next" }]
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
