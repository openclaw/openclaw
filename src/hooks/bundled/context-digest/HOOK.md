---
name: context-digest
description: "Maintain a rolling cross-session context digest in memory"
homepage: https://docs.openclaw.ai/automation/hooks#context-digest
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Context Digest Hook

Maintains a rolling cross-session context digest at `memory/context-digest.md` that provides the bot with a consolidated, topic-organized view of recent activity.

## What It Does

When triggered (on `/new`, `/reset`, or session end):

1. **Collects recent sessions** - Scans `sessions.json` for sessions updated in the last N days (default: 7)
2. **Reads transcripts** - Extracts user/assistant messages from each session (capped per session)
3. **Generates structured digest** - Uses LLM to create a topic-organized summary with sections for Topics, Decisions, Open Items, and Context
4. **Writes digest file** - Overwrites `memory/context-digest.md` with the latest digest (8KB cap)

## Output Format

```markdown
# Context Digest (auto-generated)

Last updated: 2026-03-04T10:30:00Z
Sessions covered: 12
Window: 7 days

## Topics Discussed

- Topic 1
- Topic 2

## Key Decisions

- Decision 1

## Open Items / Action Items

- [ ] Task 1
- [ ] Task 2

## Important Context

- Background info
```

## Configuration

| Option               | Type    | Default | Description                             |
| -------------------- | ------- | ------- | --------------------------------------- |
| `days`               | number  | 7       | Number of days to include in the digest |
| `maxSessionMessages` | number  | 20      | Messages to read per session            |
| `llmDigest`          | boolean | true    | Set to false for no-LLM fallback mode   |

Example:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "context-digest": {
          "enabled": true,
          "days": 14,
          "llmDigest": true
        }
      }
    }
  }
}
```

## Requirements

- **Config**: `workspace.dir` must be set

## Disabling

```bash
openclaw hooks disable context-digest
```
