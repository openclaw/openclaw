---
name: subagent-spawner
description: "Automatically spawn channel agents on gateway startup"
homepage: https://docs.openclaw.ai/hooks#subagent-spawner
metadata:
  {
    "openclaw":
      {
        "emoji": "🚀",
        "events": ["gateway:startup"],
        "install": [{ "id": "managed", "kind": "managed", "label": "Managed hook" }],
      },
  }
---

# HOOK.md - Subagent Spawner

**Hook Type:** Gateway Events
**Purpose:** Automatically spawn channel agents on gateway startup
**Events:** ["gateway:startup"]
**Handler:** handler.js

---

## What This Hook Does

When gateway starts, automatically:
1. Checks if channel agents are running (telegram-agent, discord-agent)
2. Spawns any missing agents
3. Logs spawn status
4. Ensures all channel agents are ready

---

## Agents to Spawn

| Agent Label | Purpose | Type |
|-------------|---------|-------|
| telegram-agent | Telegram message handler | Isolated session |
| discord-agent | Discord presence handler | Isolated session |

---

## Behavior

- **Agent already running**: Skip, log "already running"
- **Agent missing**: Spawn with label, purpose, task description
- **Cleanup**: `keep` - Agents stay alive between messages

---

## Task Description for Spawning

```
You are the [AGENT_LABEL]. Purpose: [PURPOSE].

Handle your channel's messages directly. Be concise, task-focused. No personality - just do the job.
```

---

## Session Labels

Agents are identified by labels for routing:
- `telegram-agent` → Messages from Telegram channel
- `discord-agent` → Messages from Discord channel
- `health-agent` → Zoidbot health monitoring (cron-triggered)

---

## Architecture Pattern

Kilocode-style subagents:
- Main agent: Orchestration, complex tasks
- Channel agents: Focused, single-purpose
- No shared state, clear ownership
- Graceful failure (one fails, others continue)
