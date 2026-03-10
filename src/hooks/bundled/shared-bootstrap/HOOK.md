---
name: shared-bootstrap
description: "Inject shared SHARED_*.md bootstrap files from the state directory into all agents"
homepage: https://docs.openclaw.ai/automation/hooks#shared-bootstrap
metadata:
  {
    "openclaw":
      {
        "emoji": "🔗",
        "events": ["agent:bootstrap"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Shared Bootstrap Hook

Auto-discovers `SHARED_*.md` files in `<stateDir>/shared/` (default `~/.openclaw/shared/`)
and injects them into every agent's `Project Context` during `agent:bootstrap`.

No configuration required. Drop files in the directory, restart, every agent gets them.

## Setup

```bash
mkdir -p ~/.openclaw/shared
echo "# Shared Rules" > ~/.openclaw/shared/SHARED_RULES.md
```

## Behavior

- Only files matching `SHARED_*.md` are loaded (e.g. `SHARED_RULES.md`, `SHARED_SOUL.md`).
- Files are sorted alphabetically and appended after workspace bootstrap files.
- If the directory does not exist or contains no matching files, the hook does nothing.
- If the directory exists but is unreadable, the error propagates to the hook runner (logged, does not block bootstrap).
- If a matching file exists but cannot be read, it is skipped with a warning.
- No subagent filtering — shared files appear in every session type.
