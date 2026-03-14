---
name: channel-bootstrap
description: "Inject per-channel bootstrap context into AGENTS.md during agent:bootstrap"
homepage: https://docs.openclaw.ai/automation/hooks#channel-bootstrap
metadata:
  {
    "openclaw":
      {
        "emoji": "🗂️",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Channel Bootstrap Hook

Appends per-channel instructions to `AGENTS.md` at bootstrap time, based on the
channel ID extracted from the active session key.

## Why

OpenClaw's global workspace files (`AGENTS.md`, `SOUL.md`, etc.) are shared across
all channels and groups. When different Discord channels, Telegram groups, or Slack
channels need distinct behavior — different personas, different callback handling,
channel-specific rules — you'd have to cram everything into one giant `AGENTS.md`.

This hook lets you split those instructions into per-channel files that only load
when the agent is active in that specific channel.

## How It Works

1. Listens for `agent:bootstrap`.
2. Parses the `sessionKey` to extract the channel or group ID.
3. Looks for `workspace/channels/{channelId}.md`.
4. If found, appends its content to the existing `AGENTS.md` bootstrap entry under
   a `## 📡 Channel-Specific Context` heading. If no `AGENTS.md` entry exists,
   a new one is created.
5. If no channel file exists, the hook exits silently — no errors, no noise.

## File Layout

```
workspace/
└── channels/
    ├── 1473810409952641138.md    ← Discord channel #dev-build
    ├── 1473460547335880776.md    ← Discord channel #jobs-intel
    ├── -1001234567890.md         ← Telegram group
    └── C0123ABCDEF.md            ← Slack channel
```

## Channel ID Extraction Rules

| Session Key Pattern                   | Extracted ID              |
| ------------------------------------- | ------------------------- |
| `…:discord:channel:123456`            | `123456`                  |
| `…:discord:channel:123456:thread:789` | `123456` (parent channel) |
| `…:telegram:group:-100123`            | `-100123`                 |
| `…:slack:channel:C123ABC`             | `C123ABC`                 |
| `…:whatsapp:group:120363…@g.us`       | `120363…@g.us`            |
| `…:main` (DM / main session)          | _(skipped)_               |

## Requirements

- OpenClaw ≥ v2026.2 (hooks system)
- Internal hooks enabled in config
- `workspace.dir` configured

## Enable

```bash
openclaw hooks enable channel-bootstrap
```

## See Also

- [Hooks documentation](https://docs.openclaw.ai/automation/hooks)
- [bootstrap-extra-files](https://docs.openclaw.ai/automation/hooks#bootstrap-extra-files)
