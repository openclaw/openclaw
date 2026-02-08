---
name: foundation-rules
description: "Inject context-relevant critical rules at the end of bootstrap to improve rule adherence"
homepage: https://docs.openclaw.ai/hooks/foundation-rules
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Foundation Rules Hook

Reads `CRITICAL-RULES.md` from your workspace and injects context-relevant rules at the end of the bootstrap file list, giving them higher attention weight than conversation history.

## What It Does

When enabled, this hook:

1. Reads `CRITICAL-RULES.md` from your workspace
2. Extracts rules relevant to the current context (channel, task type, etc.)
3. Injects them as the LAST bootstrap file, ensuring high attention weight

This helps the agent follow critical rules (like "no markdown in iMessage" or banned phrases) even when conversation history is long.

## Files

- `CRITICAL-RULES.md` — Your critical rules in natural language (required)

## Configuration

Enable the hook:

```bash
openclaw hooks enable foundation-rules
```

Config example (`~/.openclaw/openclaw.json`):

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "foundation-rules": {
          "enabled": true,
          "maxContextTokens": 150000
        }
      }
    }
  }
}
```

**Configuration Options:**

- `enabled` (boolean, default: false) - Enable/disable the hook
- `maxContextTokens` (number, default: 150000) - Maximum context size before skipping injection to prevent overflow

## CRITICAL-RULES.md Format

Use simple markdown headings to organize rules. The hook will extract sections based on context.

**Example:**

```markdown
# Critical Rules

## Channel Rules

- BlueBubbles: NO MARKDOWN (no bold, headers, bullets, code blocks). Use plain text only.
- Telegram: Markdown is OK

## Banned Phrases

- "You're absolutely right"
- "I'd be happy to help"

## Task-Specific Rules

- Email processing: Log purchases, notify deliveries, archive silently per TOOLS.md
- Heartbeat: Check HEARTBEAT.md for tasks, reply with findings or HEARTBEAT_OK
```

## How Rules Are Selected

The hook extracts rules based on:

- **Channel**: If `commandSource` matches a channel name (bluebubbles, telegram, etc.), channel-specific rules are included
- **Generic rules**: Sections like "Banned Phrases" are always included

## Behavior

- **File not found**: Hook runs silently (no error)
- **Empty file**: No rules injected
- **Malformed markdown**: Best-effort parsing, warns to console
- **Context overflow protection**: Skips injection if bootstrap context exceeds `maxContextTokens` (prevents token limit errors)

## Example Use Cases

- **Prevent markdown in plain-text channels**: Add channel-specific formatting rules
- **Enforce banned phrases**: List phrases to avoid across all responses
- **Task-specific reminders**: Email rules, heartbeat procedures, etc.

## Debugging

Enable hook logging to see what rules are injected:

```bash
# View gateway logs
tail -f ~/.openclaw/gateway.log | grep foundation-rules
```

The injected file will show as:

```
CRITICAL-RULES-ACTIVE.md
```

in the bootstrap file list.

## See Also

- [Hooks](/hooks)
- [Agent Bootstrap Event](/hooks#agent-events)
