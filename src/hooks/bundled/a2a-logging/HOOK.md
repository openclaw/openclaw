---
name: a2a-logging
description: "Log agent-to-agent messages to a Telegram topic"
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "events": ["agent_to_agent:send"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Agent-to-Agent Logging Hook

Logs cross-agent `sessions_send` messages to a configurable Telegram topic for visibility and debugging.

## What It Does

When one agent sends a message to a different agent via `sessions_send`, this hook posts a formatted log entry to a Telegram topic so you can see inter-agent communication in real time.

## Log Format

```
[14:32] finance -> dev
Summarize today's transactions and flag any anomalies...
```

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "a2a-logging": {
          "enabled": true,
          "chatId": "-1001234567890",
          "topicId": 12345
        }
      }
    }
  }
}
```

- **chatId**: Telegram group chat ID (required)
- **topicId**: Telegram forum topic/thread ID (required for forum groups)
- **token**: Telegram bot token override (optional, defaults to `channels.telegram.botToken`)

The bot must be a member of the target group with permission to post in the topic.

## Requirements

- Telegram channel must be configured (bot token available)
- Bot must have access to the target chat/topic

## Disabling

```bash
openclaw hooks disable a2a-logging
```
