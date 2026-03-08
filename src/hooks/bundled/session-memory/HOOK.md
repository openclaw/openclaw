---
name: session-memory
description: "Save and recall session context around /new, /reset, and session start"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset", "agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to your workspace memory when you issue `/new` or `/reset`, and recalls previous session context when a new session starts.

## What It Does

### Saving (on /new or /reset)

When you run `/new` or `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Generates descriptive slug** - Uses LLM to create a meaningful filename slug based on conversation content
4. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-slug.md`
5. **Sends confirmation** - Notifies you with the file path

### Recalling (on session start)

When a new session starts (agent bootstraps):

1. **Scans memory** - Reads recent memory files from `<workspace>/memory/`
2. **Filters by time** - Only considers memories within the recall window (default: all memories)
3. **Limits results** - Returns up to N memories (default: 3 most recent)
4. **Injects context** - Prepends a `[Previous Context]` block to the conversation with summaries

This helps maintain continuity across sessions about the same topic.

## Output Format

Memory files are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

## Filename Examples

The LLM generates descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session
- `2026-01-16-1430.md` - Fallback timestamp if slug generation fails

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

The hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).

## Configuration

The hook supports optional configuration:

| Option                | Type   | Default    | Description                                                                                |
| --------------------- | ------ | ---------- | ------------------------------------------------------------------------------------------ |
| `messages`            | number | 15         | Number of user/assistant messages to include in the memory file                            |
| `memoryRecallMode`    | string | "relevant" | Recall mode: "always" (inject all), "relevant" (inject if topic matches), "off" (disabled) |
| `maxMemoriesToRecall` | number | 3          | Maximum number of memory files to recall                                                   |
| `memoryRecallWindow`  | string | (none)     | Time window for recall (e.g., "7d" for 7 days, "24h" for 24 hours)                         |
| `memoryRecallTokens`  | number | 500        | Maximum tokens per recalled memory (approximate)                                           |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "memoryRecallMode": "relevant",
          "maxMemoriesToRecall": 5,
          "memoryRecallWindow": "7d",
          "memoryRecallTokens": 500
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
