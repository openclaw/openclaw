---
name: message-logger
description: "Log inbound, outbound, and transcribed messages to workspace chat history"
homepage: https://docs.openclaw.ai/automation/hooks
metadata:
  {
    "openclaw":
      {
        "emoji": "🧾",
        "events": ["message_received", "message_sent", "message_transcribed"],
        "metadataOnly": true,
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Message Logger Hook

Writes a per-contact chat history under `<workspace>/chat-history/` for inbound messages,
outbound messages, and late audio transcriptions.

## What It Does

1. Resolves a stable contact or group slug, preferring `memory/system/contacts-map.json`
2. Appends inbound and outbound entries to the daily Markdown history file
3. Stores media references alongside the same history folder
4. Replaces `[audio sem transcricao]` placeholders in place when `message_transcribed` arrives later

## Output

- Default directory: `<workspace>/chat-history/<slug>/YYYY-MM-DD.md`
- Optional media folder: `<workspace>/chat-history/<slug>/media/`

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "message-logger": {
          "enabled": true,
          "outputDir": "/path/to/custom/chat-history"
        }
      }
    }
  }
}
```

## Notes

- This metadata entry is documentation-only for the Iris typed hook registration.
- The runtime behavior is provided by the Iris plugin hook pipeline, not the directory hook loader.
