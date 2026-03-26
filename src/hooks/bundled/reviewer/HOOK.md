---
name: reviewer
description: "GPT-5.4 post-turn quality reviewer — approves or requests continuation after each agent turn"
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "events": ["message:sent"],
        "requires": {},
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Reviewer Hook

Post-turn quality gate powered by GPT-5.4. After the agent finishes a turn and delivers
its response to the channel, the reviewer evaluates the full conversation and either
approves (`:approved_by_fractal_reviewer:` reaction) or injects actionable feedback for
the agent to continue working.

## Configuration

```json
{
  "agents": {
    "defaults": {
      "reviewer": {
        "enabled": true,
        "model": "gpt-5.4",
        "maxIterations": 3,
        "approveEmoji": "approved_by_fractal_reviewer"
      }
    }
  }
}
```

| Option             | Type    | Default                        | Description                                  |
| ------------------ | ------- | ------------------------------ | -------------------------------------------- |
| `enabled`          | boolean | false                          | Enable the reviewer                          |
| `model`            | string  | "gpt-5.4"                      | OpenAI model for reviews                     |
| `maxIterations`    | number  | 3                              | Max review cycles per thread                 |
| `approveEmoji`     | string  | "approved_by_fractal_reviewer" | Reaction emoji on approval                   |
| `systemPromptPath` | string  | —                              | Path to custom reviewer SOUL.md in workspace |
