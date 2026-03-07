---
name: session-importance
description: "Identify and persist important conversations to durable memory"
homepage: https://docs.openclaw.ai/automation/hooks#session-importance
metadata:
  {
    "openclaw":
      {
        "emoji": "🏷️",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Importance Hook

Automatically identifies important conversations using a two-stage pipeline (keyword pre-filter + LLM classification) and persists them to `memory/important/` for permanent archival.

## What It Does

When `/new` or `/reset` is issued (or a session ends):

1. **Reads the previous session** transcript
2. **Stage 1 - Keyword pre-filter**: Scans for importance signals (EN/ZH keywords). Routine conversations are skipped immediately (zero LLM cost)
3. **Stage 2 - LLM classification**: Classifies the conversation and extracts structured information (summary, key points, action items)
4. **Saves to memory/important/**: Creates or appends to a permanent memory file

## Classification Categories

| Category  | Trigger                                        | minHits |
| --------- | ---------------------------------------------- | ------- |
| reference | User explicitly asks to remember/save          | 1       |
| research  | Experiments, datasets, methodology, literature | 2       |
| project   | Milestones, progress, deployments, releases    | 2       |
| decision  | Architecture choices, trade-offs, comparisons  | 2       |
| routine   | Everything else (skipped)                      | --      |

## Output Format

Files are saved as `memory/important/YYYY-MM-DD-<category>-<slug>.md`:

```markdown
# Important: project - api-v3-migration

Date: 2026-03-04
Category: project
Tags: milestone, deploy, next step

## Summary

Discussion about API migration timeline and phased rollout approach.

## Key Points

- Phase 1: Add v3 endpoints (March 15)
- Phase 2: Migrate clients (April 1)

## Action Items

- [ ] Create v3 endpoint stubs
- [ ] Draft migration guide
```

## Deduplication

When a file with a matching slug already exists, new content is appended with a timestamp divider instead of creating a duplicate file.

## Configuration

| Option        | Type     | Default | Description                                  |
| ------------- | -------- | ------- | -------------------------------------------- |
| `messages`    | number   | 30      | Number of messages to analyze per session    |
| `llmClassify` | boolean  | true    | Set to false for keyword-only classification |
| `categories`  | string[] | all     | Override which categories are active         |

Example:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-importance": {
          "enabled": true,
          "messages": 40,
          "llmClassify": true
        }
      }
    }
  }
}
```

## Requirements

- **Config**: `workspace.dir` must be set

## Disabling

```bash
openclaw hooks disable session-importance
```
