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
3. **Generates descriptive slug** - Uses LLM to create a meaningful filename slug based on conversation content
4. **Optionally synthesizes** - When `synthesis: true`, runs conversation through LLM to distill decisions, outcomes, and durable context (instead of saving raw messages)
5. **Saves to memory** - Creates a slug-named file at `<workspace>/memory/YYYY-MM-DD-slug.md` **and** appends to the canonical daily file at `<workspace>/memory/YYYY-MM-DD.md`

## Output Format

Memory files are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 EST

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

## Summary

- Decided to use Redis for session caching (rationale: low latency, built-in TTL)
- Fixed auth bug: token refresh was using expired client secret
- Next step: add rate limiting to the /api/users endpoint
```

When synthesis is disabled (default), the section is titled "Conversation Summary" and contains raw messages.

## Filename Examples

The LLM generates descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session
- `2026-01-16-1430.md` - Fallback local timestamp if slug generation fails

## Canonical Daily File

In addition to the slug-named file, the hook appends the same entry to the canonical `memory/YYYY-MM-DD.md` file. This ensures agents can find session memories on boot (which reads `memory/YYYY-MM-DD.md`) without relying on `memory_search`.

Multiple sessions on the same day are separated by `---` markers in the canonical file.

## Date Handling

Filenames use the user's local timezone rather than UTC. This prevents sessions from being filed under the wrong date when working across midnight in local time.

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during setup)

The hook uses your configured LLM provider for slug generation and synthesis.

## Configuration

The hook supports optional configuration:

| Option      | Type    | Default | Description                                                                              |
| ----------- | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `messages`  | number  | 15      | Number of user/assistant messages to include in the memory file                          |
| `llmSlug`   | boolean | true    | Whether to use LLM for generating descriptive filename slugs                             |
| `synthesis` | boolean | false   | When true, distill conversation through LLM before saving (decisions, outcomes, context) |

### Synthesis Mode

When `synthesis: true`, the hook runs the conversation through an LLM to produce a concise summary focused on:

- Decisions made and their rationale
- Actions taken and their outcomes
- Key facts, configurations, or state changes
- Problems solved and how
- Open questions or next steps

Trivial conversations (test messages, greetings) produce no output — the LLM returns `NO_SUMMARY` and the raw content is used as a fallback.

Example configuration with synthesis:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "synthesis": true,
          "messages": 25
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Uses your configured LLM for slug generation and synthesis
- Falls back to timestamp slugs if LLM is unavailable
- Falls back to raw content if synthesis fails

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
