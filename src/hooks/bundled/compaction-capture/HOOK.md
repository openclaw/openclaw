---
name: compaction-capture
description: "Preserve experiential state when context compaction occurs"
homepage: https://docs.openclaw.ai/hooks#compaction-capture
metadata:
  {
    "openclaw":
      {
        "emoji": "📸",
        "events": ["session:compaction_summary"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Compaction Capture Hook

Automatically preserves experiential state when context compaction occurs. Compaction is a critical moment because it represents context loss -- this hook ensures key contextual information is checkpointed before it fades.

## What It Does

When the system compacts conversation context:

1. **Captures the compaction summary** as a `CompactionCheckpoint`
2. **Extracts active topics** and **conversation anchors** from the summary
3. **Saves to experiential storage** (SQLite at `~/.openclaw/existence/experiential.db`)

## Configuration

Enabled by default. To disable:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "compaction-capture": { "enabled": false }
      }
    }
  }
}
```

## Disabling

```bash
openclaw hooks disable compaction-capture
```
