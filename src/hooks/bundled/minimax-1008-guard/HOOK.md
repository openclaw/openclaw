---
name: minimax-1008-guard
description: "Intercepts MiniMax 1008 billing errors (context overflow), auto-compacts the session, and prevents gateway hangs. Solves openclaw issue #24622."
metadata:
  {
    "openclaw": {
      "emoji": "🦞",
      "events": ["session:patch"],
      "requires": { "bins": ["node"] }
    }
  }
---

# MiniMax 1008 Guard

🦞 Intercepts MiniMax `insufficient balance (1008)` errors — the ones that actually mean "context window exceeded", not "you owe money". Auto-recovers so your gateway never hangs.

## The Problem

MiniMax returns HTTP 500 `insufficient balance (1008)` in **two very different situations**:

1. **True billing error** — account has no credits (rare with their token-plan)
2. **Context overflow** — request exceeded the model's context window (very common in long conversations)

OpenClaw treats both the same way: a fatal billing error that causes the gateway to hang indefinitely, requiring manual SIGTERM to restart.

This affects **every long-running OpenClaw session** using MiniMax. See [#24622](https://github.com/openclaw/openclaw/issues/24622) and [#30484](https://github.com/openclaw/openclaw/issues/30484).

## What This Hook Does

1. **Detects** the 1008 error via `session:patch` events
2. **Notifies** both the frontend (chat) and backend (logs) with a clear explanation
3. **Checks** whether context utilisation is ≥ 85% of the model window
4. **Auto-compacts** the session via `/compact` if context is high (auto-recovery)
5. **Falls back** to `/new` if context is not high (likely true billing issue)
6. **Never throws** — keeps the gateway loop alive, no manual restart needed

## Installation

This hook is bundled with OpenClaw. To enable it:

```bash
openclaw hooks enable minimax-1008-guard
openclaw gateway restart
```

Or add to your `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "minimax-1008-guard": {
          "enabled": true
        }
      }
    }
  }
}
```

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "minimax-1008-guard": {
          "enabled": true,
          "contextThresholdPct": 85,
          "autoAction": "compact"
        }
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `contextThresholdPct` | 85 | Compact when context exceeds this % of the model window |
| `autoAction` | `compact` | `compact` (auto-recover) or `new` (start fresh session) |

## Author

**lrddrl** — [GitHub](https://github.com/lrddrl/minimax-1008-guard)
