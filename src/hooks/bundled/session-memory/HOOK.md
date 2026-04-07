---
name: session-memory
description: "Save session context to memory when /new or /reset command is issued"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to your workspace memory when you issue `/new` or `/reset`.

## What It Does

When you run `/new` or `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Generates descriptive slug** - Uses LLM to create a meaningful session heading based on conversation content
4. **Saves to memory** - Appends to the canonical daily file at `<workspace>/memory/YYYY-MM-DD.md`

## Output Format

Memory files are created with the following format:

```markdown
## Session: 2026-01-16 14:30:00 — vendor-pitch

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

### Conversation Summary

user: ...
assistant: ...
```

Multiple `/reset` calls on the same day append to the same daily file, separated by `---`.

## Filename Convention

All session memory files use the canonical daily filename `YYYY-MM-DD.md`, matching the rest of the memory system (flush plan, AGENTS templates, post-compaction context). The LLM-generated slug appears in the section heading for descriptive context. If slug generation fails, the heading uses an `HHMM` timestamp fallback.

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during setup)

The hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).

## Configuration

The hook supports optional configuration:

| Option     | Type   | Default | Description                                                     |
| ---------- | ------ | ------- | --------------------------------------------------------------- |
| `messages` | number | 15      | Number of user/assistant messages to include in the memory file |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Uses your configured LLM for slug generation
- Falls back to timestamp slugs if LLM is unavailable

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-memory
```

Or remove it from your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
