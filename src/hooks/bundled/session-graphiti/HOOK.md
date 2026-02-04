---
name: session-graphiti
description: "Store conversation excerpts for Graphiti sync when sessions end"
homepage: https://docs.openclaw.ai/hooks#session-graphiti
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["command:new", "command:reset", "command:stop"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Graphiti Hook

Captures the most recent user/assistant exchanges when a session ends and writes a JSONL record that the Graphiti sync job can ingest.

## What It Does

When you run `/new`, `/reset`, or `/stop`:

1. **Finds the session transcript** (uses the pre-reset entry for `/new` and `/reset`)
2. **Extracts recent messages** (default: 12 user/assistant turns)
3. **Detects signals** (deploys, incidents, fixes, tests, etc.)
4. **Appends JSONL** to `<workspace>/memory/conversations.jsonl`

## Output

`<workspace>/memory/conversations.jsonl`

Each entry includes:

- session metadata (session id, session key, channel, thread id)
- message counts + excerpt
- detected signals for quick filtering

## Configuration

Optional per-hook config:

| Option     | Type   | Default | Description                          |
| ---------- | ------ | ------- | ------------------------------------ |
| `messages` | number | 12      | Number of recent messages to include |

Example:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-graphiti": {
          "enabled": true,
          "messages": 20
        }
      }
    }
  }
}
```

## Disabling

```bash
openclaw hooks disable session-graphiti
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-graphiti": { "enabled": false }
      }
    }
  }
}
```
