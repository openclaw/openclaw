---
name: session-end
description: "Archive Meridia session capture buffer on /new or /stop"
metadata:
  {
    "openclaw":
      {
        "emoji": "📦",
        "events": ["command:new", "command:stop"],
        "requires": { "config": ["hooks.internal.entries.session-end.enabled"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session End (Meridia)

On `/new` and `/stop`, archives the current Meridia buffer into a session summary file.

