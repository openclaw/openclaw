---
name: closing-turn
description: "Run a silent closing turn to save session context when /new or /reset is issued"
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Closing Turn Hook

Automatically runs a silent agent turn on the previous session's transcript when `/new` or `/reset` is issued. The agent reviews the conversation and updates workspace files (memory logs, tasks, project status) before the context is lost.

## What It Does

When you run `/new` or `/reset`:

1. **Finds the previous session transcript** — uses `previousSessionEntry` to locate the JSONL file
2. **Sends progress notice** — pushes a status message so you know it's working
3. **Spawns a background agent turn** — runs `agentCommand()` with the closing prompt on the archived transcript
4. **Agent updates workspace** — writes to memory logs, creates/completes tasks, updates project files
5. **Runs silently** — never delivers output to the user; the new session starts immediately

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "closing-turn": {
          "enabled": true,
          "timeoutSeconds": 120,
          "model": "haiku"
        }
      }
    }
  }
}
```

| Option           | Type    | Default         | Description                             |
| ---------------- | ------- | --------------- | --------------------------------------- |
| `enabled`        | boolean | true            | Enable/disable the hook                 |
| `timeoutSeconds` | number  | 120             | Hard timeout for the closing turn agent |
| `model`          | string  | (agent default) | Model override for the closing turn     |

## Disabling

```bash
openclaw hooks disable closing-turn
```

Or set `"enabled": false` in config.
