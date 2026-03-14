---
name: cache-ttl-warning
description: "Warn the user before the Anthropic prompt cache TTL expires so they can reset it with a message"
metadata:
  {
    "openclaw":
      {
        "emoji": "⏱️",
        "events": ["message:sent", "message:received", "command:new", "command:reset"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Cache TTL Warning Hook

Tracks the time since the last message exchange in a conversation and sends a
warning before the Anthropic prompt cache TTL expires. This gives the user a
chance to send any message to reset the cache clock before the full context
must be re-sent.

## What It Does

On every `message:sent` or `message:received` event for a watched conversation:

1. **Resets the timer** — cancels any existing countdown for that conversation
2. **Starts a new countdown** — fires a warning at `warningSeconds` (default: 240s / 4 min)
3. **Sends a warning message** — notifies the user they have ~1 minute before cache expires
4. **Optional expired notice** — sends a second notice at `expiredSeconds` (default: 300s / 5 min)

Sending any message (in either direction) resets the timer.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "cache-ttl-warning": {
          "enabled": true,
          "warningSeconds": 240,
          "expiredSeconds": 300,
          "watchConversations": ["telegram:7898601152"]
        }
      }
    }
  }
}
```

| Option               | Type     | Default | Description                                                                                          |
| -------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `enabled`            | boolean  | true    | Enable/disable the hook                                                                              |
| `warningSeconds`     | number   | 240     | Seconds after last message to send the warning (4 min)                                               |
| `expiredSeconds`     | number   | 300     | Seconds after last message to send the expired notice (5 min). Set to 0 to disable.                  |
| `watchConversations` | string[] | []      | List of `channel:conversationId` pairs to watch. Empty = watch all direct (non-group) conversations. |

## Disabling

```bash
openclaw hooks disable cache-ttl-warning
```

Or set `"enabled": false` in config.
