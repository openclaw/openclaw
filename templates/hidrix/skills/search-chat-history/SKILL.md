---
name: search-chat-history
description: Search chat history from Telegram/Slack conversations using grep. Find who said what and when with exact timestamps.
---

# search-chat-history

Search real-time ingested chat history. Use when users ask about past conversations, who said something, or when something was discussed.

## Trigger

Use this skill when:

- "ai nói gì về X?" / "who said X?"
- "lúc nào bàn về Y?" / "when did we discuss Y?"
- Recall exact quotes or timestamps
- Reference past group conversations

## Tools

Two tools in `workspace/tools/`:

### search-chat.sh

```bash
./tools/search-chat.sh "query" [limit] [month]
```

**Examples:**

```bash
./tools/search-chat.sh "n8n"              # Search all
./tools/search-chat.sh "Giang" 10         # Limit 10 results
./tools/search-chat.sh "AI" 20 2026-03    # March 2026 only
```

**Output:**

```
Found 17 result(s) for "Giang" (showing first 10):

[2026-03.md:5] **Giang VT** (2026-03-18T21:48 PST): hi @hidrixbot
[2026-03.md:6] **Giang VT** (2026-03-18T21:48 PST): [reply] mình có thể nhờ...
```

### convert-timestamps.sh

Convert existing chat history to ISO format for precise searching.

```bash
./tools/convert-timestamps.sh [file]
```

## Chat History Location

```
workspace/knowledge/chat-history/
├── telegram/
│   └── 2026-03.md    # Monthly files
└── slack/
    └── #channel.md
```

## Tips

1. Search is case-insensitive
2. Vietnamese text works fine
3. Use `| head -20` to limit output
4. If no history found, chat ingest may not be enabled
