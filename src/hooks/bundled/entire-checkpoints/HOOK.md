---
name: entire-checkpoints
description: "Track AI coding sessions with Entire CLI checkpoints"
metadata:
  {
    "openclaw":
      {
        "emoji": "📸",
        "events": ["command:new", "command:reset", "command:stop", "gateway:startup"],
        "requires": { "anyBins": ["entire"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Entire Checkpoints Hook

Automatically tracks AI coding sessions using [Entire CLI](https://entire.dev) checkpoints. This enables full session-level observability: every AI interaction is recorded as a checkpoint that can be reviewed, diffed, and shared.

## What It Does

This hook integrates OpenClaw with Entire CLI's agent hook system. It maps OpenClaw lifecycle events to Entire checkpoint verbs:

| OpenClaw Event    | Entire Verb            | Description                             |
| ----------------- | ---------------------- | --------------------------------------- |
| `gateway:startup` | `session-start`        | Begins a new Entire tracking session    |
| `command:new`     | `stop` → `session-end` | Ends current checkpoint, closes session |
| `command:reset`   | `stop` → `session-end` | Ends current checkpoint, closes session |
| `command:stop`    | `stop`                 | Ends the current checkpoint             |

Each call pipes a JSON payload to `entire hooks openclaw <verb>` via stdin:

```json
{
  "session_id": "<session-id>",
  "transcript_path": "<path-to-session-file>",
  "prompt": "<first-user-message>"
}
```

## Requirements

- **Entire CLI** must be installed and available in `PATH` (`entire` binary)
- **Project must be Entire-enabled**: run `entire enable --agent openclaw` in your project root
- The hook checks for `.entire/settings.json` in the workspace directory and silently skips if not found

## Configuration

No additional configuration is needed. The hook activates automatically when:

1. The `entire` binary is found in `PATH`
2. The current workspace has `.entire/settings.json`

## Disabling

```bash
openclaw hooks disable entire-checkpoints
```

Or in your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "entire-checkpoints": { "enabled": false }
      }
    }
  }
}
```

## Learn More

- [Entire CLI documentation](https://entire.dev/docs)
- [Agent integration (entireio/cli#297)](https://github.com/entireio/cli/pull/297)
