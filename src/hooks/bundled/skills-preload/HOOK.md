---
name: skills-preload
description: "Preload skill content into the agent system prompt at session start so models never need a Read tool call for high-frequency branded knowledge."
homepage: https://docs.openclaw.ai/automation/hooks#skills-preload
metadata:
  {
    "openclaw":
      {
        "emoji": "📚",
        "events": ["agent:bootstrap"],
        "always": true,
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Skills Preload Hook

Embeds selected skill content directly into each agent's system prompt under
`# Project Context` during `agent:bootstrap`. Eliminates the need for the model
to invoke the `Read` tool to access high-frequency knowledge files.

## Why

Skills normally expose only their `description` (frontmatter) in the system
prompt — actual file content has to be loaded on demand via the `Read` tool.
For branded knowledge that every session needs (company voice, services,
pricing, guarantees, sales playbook), that pattern leaks the file content
into the chat UI as a `tool_result` block on first use.

This hook lets you mark a skill `preload: true` in its `SKILL.md` frontmatter,
and optionally list specific sibling files via `preload-files`. The hook reads
those files at session start and inlines them into the system prompt as
bootstrap context, where Anthropic prompt caching makes them effectively free
on every subsequent turn.

## Configuration

The hook is **enabled by default** for any workspace where skills declare
`preload: true`. To disable globally:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "skills-preload": {
          "enabled": false
        }
      }
    }
  }
}
```

## Marking a skill for preload

In `skills/<your-skill>/SKILL.md`:

```yaml
---
name: My Knowledge Base
description: "..."
preload: true
preload-files:
  - core-facts.md
  - voice-guide.md
  - pricing.md
---
```

`preload: true` always loads `SKILL.md` itself. Add `preload-files` (a list of
paths relative to the skill directory) to also load named sibling files.

## Limits

- Per-file cap: **64 KB**. Larger files are skipped with a warning.
- Aggregate per-bootstrap cap: **256 KB** across all preloaded skills.
- Hooks runs once per agent session start. Subagents inherit the same content
  via the bootstrap allowlist (preloaded entries use `AGENTS.md` as their
  bootstrap-name slot so they survive subagent filtering).
- Path traversal outside the skill directory is rejected.
