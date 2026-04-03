---
name: extract-memories
description: 'Automatically extract and save noteworthy information from conversations to memory topic files'
metadata:
  {
    'openclaw':
      {
        'emoji': '🧠',
        'events': ['message:sent'],
        'requires': { 'config': ['workspace.dir'] },
        'install': [{ 'id': 'bundled', 'kind': 'bundled', 'label': 'Bundled with OpenClaw' }],
      },
  }
---

# Extract Memories Hook

Automatically analyzes conversations and extracts noteworthy information into memory topic files.

## What It Does

After each sent message (with cooldown and minimum message thresholds), the hook:

1. **Reads existing topic files** - Scans `<workspace>/memory/topics/` for context
2. **Analyzes the conversation** - Uses an LLM to identify information worth remembering long-term
3. **Writes topic files** - Saves extracted memories to `<workspace>/memory/topics/<filename>`
4. **Updates MEMORY.md** - Appends new topic entries to the index if it exists

## Types of Memories Saved

- **user** - Role, preferences, knowledge level
- **feedback** - Corrections and confirmations of approach
- **project** - Ongoing work context not derivable from code
- **reference** - Pointers to external systems, API endpoints

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during setup)
- **Env**: API key env var (default: `GEMINI_API_KEY`) must be set

## Configuration

| Option             | Type   | Default                                                        | Description                          |
| ------------------ | ------ | -------------------------------------------------------------- | ------------------------------------ |
| `cooldownMinutes`  | number | 5                                                              | Minimum minutes between extractions  |
| `minMessages`      | number | 3                                                              | Minimum new messages before trigger  |
| `model`            | string | `gemini-2.0-flash`                                             | LLM model to use                     |
| `baseUrl`          | string | `https://generativelanguage.googleapis.com/v1beta/openai`      | OpenAI-compatible API base URL       |
| `apiKeyEnv`        | string | `GEMINI_API_KEY`                                               | Environment variable holding API key |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "extract-memories": {
          "enabled": true,
          "cooldownMinutes": 5,
          "minMessages": 3,
          "model": "gemini-2.0-flash",
          "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
          "apiKeyEnv": "GEMINI_API_KEY"
        }
      }
    }
  }
}
```

## Disabling

```bash
openclaw hooks disable extract-memories
```
