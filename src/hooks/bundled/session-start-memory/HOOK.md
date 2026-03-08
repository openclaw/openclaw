---
name: session-start-memory
description: "Load workspace memory files into session context at startup"
homepage: https://docs.openclaw.ai/hooks#session-start-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Start Memory Hook

Automatically loads workspace memory files into session context at agent bootstrap, making memory loading **structural** instead of **optional**.

## What It Does

Every time an agent session starts (new session, `/new` command, gateway restart):

1. **Loads configured paths** - Reads specified files like `MEMORY.md`, `continuity-test.md`
2. **Loads recent memory** - Finds and includes recent `memory/YYYY-MM-DD*.md` files
3. **Injects into context** - Makes all content available as `CURRENT_SESSION_MEMORY.md` in workspace context
4. **Enforces continuity** - Memory loading happens before any user messages are processed

## Why It Matters

Without this hook, agents must manually read memory files - and often forget. This hook makes memory loading **automatic and unskippable**, solving the "amnesia problem" where agents lose continuity across sessions.

## Use Cases

- **Continuity testing** - Load a test question that verifies the agent remembers recent work
- **Long-term memory** - Inject curated `MEMORY.md` into every session
- **Recent context** - Automatically surface last few days of work
- **Session checklists** - Ensure important context is always present

## Configuration

The hook supports optional configuration:

| Option       | Type       | Default                                      | Description                                        |
| ------------ | ---------- | -------------------------------------------- | -------------------------------------------------- |
| `paths`      | `string[]` | `["MEMORY.md", "memory/continuity-test.md"]` | Paths to always load (relative to workspace)      |
| `recentDays` | `number`   | `2`                                          | Number of recent days to load from `memory/` dir   |

### Example Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-start-memory": {
          "enabled": true,
          "paths": ["MEMORY.md", "docs/context.md"],
          "recentDays": 3
        }
      }
    }
  }
}
```

## Output Format

The hook generates `CURRENT_SESSION_MEMORY.md` with this structure:

```markdown
# Current Session Memory
*Auto-generated at 2026-02-06T13:00:00.000Z*

## MEMORY.md

[content of MEMORY.md]

---

## continuity-test.md

[content of continuity-test.md]

---

## Recent Memory (Last 2 Days)

### memory/2026-02-06-bug-fix.md

[content]

### memory/2026-02-05-feature-work.md

[content]
```

## File Matching

Recent memory files are matched by pattern: `memory/YYYY-MM-DD*.md`

Examples that match:
- `memory/2026-02-06.md`
- `memory/2026-02-06-bug-fix.md`
- `memory/2026-02-05-1430.md`

Files are sorted newest-first.

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)
- **Files**: All specified paths are optional - hook silently skips missing files

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-start-memory
```

Or in config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-start-memory": { "enabled": false }
      }
    }
  }
}
```

## How It Works

1. Listens for `agent:bootstrap` event (fires before first user message in session)
2. Reads configured paths and recent memory files from workspace
3. Injects combined content into `bootstrapFiles` array
4. OpenClaw loads this as workspace context automatically

The key insight: By running at `agent:bootstrap` instead of relying on manual reads, memory loading becomes **structural** - there's no way to skip it.
