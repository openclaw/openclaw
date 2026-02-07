---
name: experiential-reconstitution
description: "Inject experiential context at session start for continuity"
homepage: https://docs.openclaw.ai/hooks#experiential-reconstitution
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["hooks.internal.entries.experiential-reconstitution.enabled"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Experiential Reconstitution Hook

Injects experiential context at session start for continuity across sessions. This hook restores key context -- recent session summaries, compaction checkpoints, and significant moments -- so the agent can maintain experiential continuity.

## What It Does

When a new agent session bootstraps:

1. **Loads recent experiential data** from the store (summaries, checkpoints, moments)
2. **Determines reconstitution depth** based on time since last activity
3. **Builds reconstitution context** and writes it to `EXISTENCE.md` in the workspace
4. **Injects into bootstrap** so the agent starts with experiential awareness

## Reconstitution Depth

- **Quick** (<4 hours since last activity): Last emotional signature + recent anchors
- **Standard** (4-24 hours): Full recent summary + relationship context
- **Deep** (>24 hours): Multi-session synthesis + pattern analysis

## Configuration

This hook is **opt-in** (requires explicit enable):

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "experiential-reconstitution": { "enabled": true }
      }
    }
  }
}
```

## Enable

```bash
openclaw hooks enable experiential-reconstitution
```
