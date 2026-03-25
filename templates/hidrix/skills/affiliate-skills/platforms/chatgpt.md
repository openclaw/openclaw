# Using affiliate-skills with ChatGPT

## Overview

ChatGPT (GPT-4o and later) works well with affiliate-skills through web browsing for live API calls
and file upload for loading skill documentation as knowledge context. No local file system access
is required for the majority of skills.

**What works well:**

- Content, blog post, and landing page generation skills
- API-powered skills (web browsing handles HTTP calls to `list.affitor.com/api/v1`)
- Skills that output text, markdown, or structured data

**Requires workaround:**

- Skills that invoke the `affiliate-check` CLI (no terminal access in ChatGPT)

---

## Method 1: Custom GPT (Recommended)

Best for teams or repeated use — configure once, use always.

1. Go to [chatgpt.com](https://chatgpt.com) → **Explore GPTs** → **Create**
2. Switch to the **Configure** tab
3. In **Instructions**, paste the full content of `bootstrap.md` from this repo
4. Enable **Web Browsing** in the Capabilities section
5. Under **Knowledge**, upload:
   - `registry.json` — skill index, lets the GPT discover available skills
   - `docs/API.md` — HTTP reference for `list.affitor.com/api/v1`
   - Any specific `SKILL.md` files for workflows you use often (e.g., `skills/blog-post/SKILL.md`)
6. Name the GPT (e.g., "Affitor Skills Agent") and save
7. Start a conversation: `Run the /blog-post skill for [program name]`

---

## Method 2: GPT Projects

Available to ChatGPT Plus users — instructions and files persist across all conversations in the project.

1. Create a new **Project** in the sidebar
2. Open **Project Instructions** and paste `bootstrap.md` content
3. Attach files to the project:
   - `registry.json`
   - `docs/API.md`
   - Skill `.md` files you want available
4. Every conversation in this project inherits the instructions and file context

---

## Method 3: Single Conversation

Quickest way to try it out — no setup required.

1. Open a new ChatGPT conversation
2. Paste the full content of `bootstrap.md` as your first message
3. Follow with your skill request:
   ```
   Run /landing-page for Notion affiliate program. Commission: 25%, cookie: 90 days.
   ```
4. ChatGPT will follow the skill workflow and use web browsing for any API lookups

---

## Tips

- **Best-performing skills in ChatGPT**: `/blog-post`, `/landing-page`, `/content-brief`,
  `/email-sequence`, `/product-comparison` — all text-output skills work great
- **For API-heavy skills**: enable web browsing so ChatGPT can hit `list.affitor.com/api/v1`
  endpoints directly
- **Upload skill files**: for complex multi-step workflows, upload the specific `SKILL.md` so
  ChatGPT has the exact step definitions as reference
- **Batch requests**: Custom GPTs maintain skill context, so you can chain: "Now run /meta-description
  for the same program" without re-pasting context

---

## Limitations

- No local file system access — skills that write files to disk require copy-paste output
- Cannot run `affiliate-check` CLI binary (no terminal)
- Web browsing may be slower than a direct API call from Claude Code or a local agent
- Context window limits apply — for very large registry files, summarize or reference specific skills
