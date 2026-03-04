---
name: exec-notify-wake
description: "When a background exec completes, trigger an agent turn to acknowledge the result"
metadata:
  {
    "openclaw":
      {
        "emoji": "⚡",
        "events": ["exec:completed", "exec:failed"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Exec Notify Wake Hook

When a background exec completes with `onComplete="notify"`, the gateway enqueues a
system event but relies on the heartbeat wake handler to trigger an agent turn. When
heartbeats are disabled, the wake handler is never registered and the system event
sits unconsumed.

This hook listens to `exec:completed` and `exec:failed` internal hook events (fired
directly from `maybeNotifyOnExit`) and calls `agentCommand()` to trigger a new turn
so the agent can acknowledge and act on the result.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "exec-notify-wake": {
        "enabled": true
      }
    }
  }
}
```

Enabled by default when installed. Set `enabled: false` to disable.
