---
name: session-capture
description: "Capture experiential session summary when /new command is issued"
homepage: https://docs.openclaw.ai/hooks#session-capture
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["command:new"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Capture Hook

Automatically synthesizes experiential session data when a session ends via `/new`.

## What It Does

When you run `/new` to start a fresh session:

1. **Reads the previous session transcript** to extract topics and context
2. **Collects any buffered moments** from the experiential store
3. **Creates a `SessionSummary`** with topics, moment counts, and reconstitution hints
4. **Saves to experiential storage** (SQLite at `~/.openclaw/existence/experiential.db`)

## Configuration

Enabled by default. To disable:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-capture": { "enabled": false }
      }
    }
  }
}
```

## Disabling

```bash
openclaw hooks disable session-capture
```
