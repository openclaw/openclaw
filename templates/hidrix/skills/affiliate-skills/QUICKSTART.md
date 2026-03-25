# Quick Start Guide

Pick your AI platform and follow the steps. You'll be running affiliate marketing skills in under 5 minutes.

---

## Claude Code

Full integration with slash commands and the `affiliate-check` CLI tool.

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Git](https://git-scm.com/), [Bun](https://bun.sh/) v1.0+

**Steps:**

1. Open Claude Code and paste:

> Install affiliate-skills: run `git clone https://github.com/Affitor/affiliate-skills.git ~/.claude/skills/affiliate-skills && cd ~/.claude/skills/affiliate-skills && ./setup` then add an "affiliate-skills" section to CLAUDE.md that says to use `/affiliate-check` for all affiliate program lookups, and lists the available skills: 45 skills across 8 stages (research, content, blog, landing, distribution, analytics, automation, meta). Set `AFFITOR_API_KEY` env var for unlimited access.

2. Claude Code auto-discovers all 45 skills from the `SKILL.md` files
3. Use naturally: _"Find me the best AI video affiliate program"_ or _"Write a LinkedIn post about HeyGen"_

**What you get:** Slash commands, `affiliate-check` CLI with live data, automatic skill chaining.

---

## ChatGPT / GPT Projects

Works with ChatGPT Plus, Team, or Enterprise. No code required.

**Option A — Quick start (no install):**

1. Open ChatGPT
2. Copy the entire content of [`prompts/bootstrap.md`](prompts/bootstrap.md) (everything below the `---` line)
3. Paste it as your first message or add it to a GPT Project's instructions
4. Start prompting: _"Find me the best SaaS affiliate programs with recurring commission"_

**Option B — Custom GPT:**

1. Go to [ChatGPT → Create a GPT](https://chatgpt.com/gpts/editor)
2. In **Instructions**, paste the content of [`prompts/bootstrap.md`](prompts/bootstrap.md)
3. Enable **Web Browsing** (so it can call the API and browse list.affitor.com)
4. Optionally upload [`registry.json`](registry.json) and [`API.md`](API.md) as knowledge files
5. Save and share with your team

**Option C — Upload the repo:**

1. Download this repo as a ZIP from GitHub
2. In a ChatGPT conversation, upload the ZIP or individual SKILL.md files you need
3. Say: _"Use these skill files to help me with affiliate marketing"_

---

## Cursor / Windsurf / AI Code Editors

Skills auto-activate when you open the repo.

**Steps:**

1. Clone the repo into your project:
   ```bash
   git clone https://github.com/Affitor/affiliate-skills.git
   ```
2. Open the folder in Cursor — it reads `.cursorrules` automatically
3. For Windsurf, the SKILL.md files work as context when referenced
4. Start prompting in the AI chat: _"Search for affiliate programs in the AI niche"_

**Tip:** For the `affiliate-check` CLI, run `cd affiliate-skills && ./setup` in the terminal first.

---

## Gemini

Works with Gemini Advanced (file upload) or Google AI Studio.

**Option A — Quick start:**

1. Open [Gemini](https://gemini.google.com)
2. Copy the content of [`prompts/bootstrap.md`](prompts/bootstrap.md) and paste as your first message
3. Start prompting

**Option B — With full context:**

1. Upload these files to a Gemini conversation:
   - `prompts/bootstrap.md` — core instructions
   - `API.md` — API reference
   - `registry.json` — skill index
   - Any specific `SKILL.md` files for skills you want to use
2. Say: _"You are my affiliate marketing agent. Use these files as your instructions."_

**Note:** Gemini can browse the web, so API calls to list.affitor.com work directly.

---

## Any Other AI (Universal Method)

Works with any AI that accepts text input — OpenClaw, Perplexity, Mistral, local models, or custom agent frameworks.

**Steps:**

1. Open [`prompts/bootstrap.md`](prompts/bootstrap.md)
2. Copy everything below the `---` line
3. Paste it into your AI as the system prompt or first message
4. Start with: _"Search for the best affiliate programs for [your niche]"_

**For AI agents with HTTP access:** The bootstrap prompt includes API details. The AI will call `list.affitor.com/api/v1/programs` directly.

**For AI without HTTP access:** Ask the AI to generate the search URL, visit it yourself, and paste the JSON response back.

**For developers building agent pipelines:**

- Use [`registry.json`](registry.json) as a machine-readable skill index
- Each skill's `SKILL.md` has typed Input/Output schemas for structured data exchange
- See [`API.md`](API.md) for endpoint documentation
- Skills in `agents/openai.yaml` format are available for OpenAI-compatible tool definitions

---

## Without Installing Anything

Want to try before you commit? Paste this into any AI right now:

```
Search the Affitor affiliate directory for AI video tools.
Use this API: GET https://list.affitor.com/api/v1/programs?q=AI+video&sort=top&limit=5
Show me the results in a table with: Name, Commission, Cookie Duration, Stars.
Then recommend the best one and explain why.
```

No API key needed. Free tier returns up to 5 results.

---

## Next Steps

- Browse programs: [list.affitor.com](https://list.affitor.com)
- Full skill reference: [README.md](README.md)
- API documentation: [API.md](API.md)
- Contribute a skill: [CONTRIBUTING.md](CONTRIBUTING.md)
