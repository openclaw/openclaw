---
name: daily-memory
description: "Create daily memory log templates on startup and agent bootstrap"
homepage: https://docs.openclaw.ai/automation/hooks#daily-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "🗓️",
        "events": ["agent:bootstrap", "gateway:startup"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Daily Memory Hook

Creates empty daily memory log templates inside `<workspace>/memory/` for today and a configurable
number of future days.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "daily-memory": {
          "enabled": true,
          "template": "# {{date}} - Daily Log\n\n## Morning Notes\n\n## Afternoon Progress\n\n## Evening Reflection\n",
          "createDaysAhead": 1
        }
      }
    }
  }
}
```

## Options

- `template` (string): Markdown template used for new files. `{{date}}` is replaced with `YYYY-MM-DD`.
- `createDaysAhead` (number): Number of future daily logs to create in addition to today.

This hook only creates missing files. Existing daily logs are left untouched.
