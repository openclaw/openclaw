---
name: compaction
description: "Preserve Meridia continuity state before auto-compaction"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "events": ["agent:precompact", "agent:compaction:end"],
        "requires": { "config": ["hooks.internal.entries.compaction.enabled"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Compaction (Meridia)

Creates a snapshot of recent context when the embedded agent begins auto-compaction.

