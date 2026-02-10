---（轉為繁體中文）
name: session-memory（轉為繁體中文）
description: "Save session context to memory when /new command is issued"（轉為繁體中文）
homepage: https://docs.openclaw.ai/hooks#session-memory（轉為繁體中文）
metadata:（轉為繁體中文）
  {（轉為繁體中文）
    "openclaw":（轉為繁體中文）
      {（轉為繁體中文）
        "emoji": "💾",（轉為繁體中文）
        "events": ["command:new"],（轉為繁體中文）
        "requires": { "config": ["workspace.dir"] },（轉為繁體中文）
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],（轉為繁體中文）
      },（轉為繁體中文）
  }（轉為繁體中文）
---（轉為繁體中文）
（轉為繁體中文）
# Session Memory Hook（轉為繁體中文）
（轉為繁體中文）
Automatically saves session context to your workspace memory when you issue the `/new` command.（轉為繁體中文）
（轉為繁體中文）
## What It Does（轉為繁體中文）
（轉為繁體中文）
When you run `/new` to start a fresh session:（轉為繁體中文）
（轉為繁體中文）
1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript（轉為繁體中文）
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)（轉為繁體中文）
3. **Generates descriptive slug** - Uses LLM to create a meaningful filename slug based on conversation content（轉為繁體中文）
4. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-slug.md`（轉為繁體中文）
5. **Sends confirmation** - Notifies you with the file path（轉為繁體中文）
（轉為繁體中文）
## Output Format（轉為繁體中文）
（轉為繁體中文）
Memory files are created with the following format:（轉為繁體中文）
（轉為繁體中文）
```markdown（轉為繁體中文）
# Session: 2026-01-16 14:30:00 UTC（轉為繁體中文）
（轉為繁體中文）
- **Session Key**: agent:main:main（轉為繁體中文）
- **Session ID**: abc123def456（轉為繁體中文）
- **Source**: telegram（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Filename Examples（轉為繁體中文）
（轉為繁體中文）
The LLM generates descriptive slugs based on your conversation:（轉為繁體中文）
（轉為繁體中文）
- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation（轉為繁體中文）
- `2026-01-16-api-design.md` - API architecture planning（轉為繁體中文）
- `2026-01-16-bug-fix.md` - Debugging session（轉為繁體中文）
- `2026-01-16-1430.md` - Fallback timestamp if slug generation fails（轉為繁體中文）
（轉為繁體中文）
## Requirements（轉為繁體中文）
（轉為繁體中文）
- **Config**: `workspace.dir` must be set (automatically configured during onboarding)（轉為繁體中文）
（轉為繁體中文）
The hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).（轉為繁體中文）
（轉為繁體中文）
## Configuration（轉為繁體中文）
（轉為繁體中文）
The hook supports optional configuration:（轉為繁體中文）
（轉為繁體中文）
| Option     | Type   | Default | Description                                                     |（轉為繁體中文）
| ---------- | ------ | ------- | --------------------------------------------------------------- |（轉為繁體中文）
| `messages` | number | 15      | Number of user/assistant messages to include in the memory file |（轉為繁體中文）
（轉為繁體中文）
Example configuration:（轉為繁體中文）
（轉為繁體中文）
```json（轉為繁體中文）
{（轉為繁體中文）
  "hooks": {（轉為繁體中文）
    "internal": {（轉為繁體中文）
      "entries": {（轉為繁體中文）
        "session-memory": {（轉為繁體中文）
          "enabled": true,（轉為繁體中文）
          "messages": 25（轉為繁體中文）
        }（轉為繁體中文）
      }（轉為繁體中文）
    }（轉為繁體中文）
  }（轉為繁體中文）
}（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
The hook automatically:（轉為繁體中文）
（轉為繁體中文）
- Uses your workspace directory (`~/.openclaw/workspace` by default)（轉為繁體中文）
- Uses your configured LLM for slug generation（轉為繁體中文）
- Falls back to timestamp slugs if LLM is unavailable（轉為繁體中文）
（轉為繁體中文）
## Disabling（轉為繁體中文）
（轉為繁體中文）
To disable this hook:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
openclaw hooks disable session-memory（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Or remove it from your config:（轉為繁體中文）
（轉為繁體中文）
```json（轉為繁體中文）
{（轉為繁體中文）
  "hooks": {（轉為繁體中文）
    "internal": {（轉為繁體中文）
      "entries": {（轉為繁體中文）
        "session-memory": { "enabled": false }（轉為繁體中文）
      }（轉為繁體中文）
    }（轉為繁體中文）
  }（轉為繁體中文）
}（轉為繁體中文）
```（轉為繁體中文）
