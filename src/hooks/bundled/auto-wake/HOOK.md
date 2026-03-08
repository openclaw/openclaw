---
name: auto-wake
description: "Assistant speaks first after gateway restart"
homepage: https://docs.openclaw.ai/automation/hooks#auto-wake
metadata:
  {
    "openclaw":
      {
        "emoji": "👋",
        "events": ["gateway:startup", "agent:bootstrap"],
        "requires": { "config": ["gateway.port", "gateway.auth.token"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Auto-Wake Hook

After gateway startup, sends a message to the main webchat session via the
`/v1/chat/completions` HTTP endpoint with `x-openclaw-session-key: agent:main:main`.
This triggers the full bootstrap chain and the assistant responds in the UI without
the user having to type first.

## Why Two Events?

`gateway:startup` fires before hooks finish loading (~3-5 s gap). By also subscribing
to `agent:bootstrap` (which fires when the boot session starts), the handler catches
whichever event arrives first after it is ready.

## Dedup

A file stamp (`~/.openclaw/.auto-wake-stamp`) prevents double-fire within a 2-minute
window, handling multiple bootstrap events and rapid restart sequences.

## Configuration

Enable in `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "auto-wake": { "enabled": true }
      }
    }
  }
}
```

Requires `gateway.auth.token` to be set (used as Bearer token on the POST).
