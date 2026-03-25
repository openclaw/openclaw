# Using affiliate-skills with Gemini

## Overview

Gemini Advanced (Ultra 1.5 and Gemini 2.0+) supports file upload and web browsing, making it
compatible with most affiliate-skills workflows. Upload skill documentation as context, and
Gemini will follow the structured workflows to produce affiliate content and analysis.

Google AI Studio (api.google.com) is available for developers who want to embed skills into
applications or automate via the Gemini API.

---

## Method 1: Quick Start (No Setup)

The fastest way to run a skill in Gemini:

1. Open [gemini.google.com](https://gemini.google.com) (requires Gemini Advanced)
2. Paste the full content of `bootstrap.md` as your opening message
3. Follow with a skill request:

```
Run /blog-post for the Canva affiliate program.
Commission: 20%, cookie: 30 days, target audience: small business owners and designers.
```

Gemini will interpret the bootstrap context and execute the skill workflow step by step.

---

## Method 2: Deep Context (Recommended for Complex Skills)

Upload skill files for richer, more accurate outputs — especially for multi-step or
API-dependent skills.

1. Start a new Gemini Advanced conversation
2. Click the **attachment icon** and upload:
   - `bootstrap.md` — core skill system context
   - `docs/API.md` — API reference for `list.affitor.com/api/v1`
   - `registry.json` — full skill index
   - The specific `SKILL.md` for the skill you want to run (e.g., `skills/email-sequence/SKILL.md`)
3. In your message, reference the uploaded files:

```
Using the uploaded SKILL.md, run /email-sequence for HubSpot affiliate program.
Program details: 30% recurring commission, 90-day cookie, B2B SaaS audience.
```

Gemini reads all uploaded files as part of its context window — no need to paste file contents.

---

## Google AI Studio

For developers building applications or automated pipelines:

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Create a new prompt → switch to **System Instruction** mode
3. Paste `bootstrap.md` content into the system instruction field
4. Upload `registry.json` and `API.md` as context files
5. Use the API to call Gemini with skill requests programmatically:

```python
import google.generativeai as genai

genai.configure(api_key="YOUR_API_KEY")
model = genai.GenerativeModel("gemini-2.0-flash")

# System instruction set to bootstrap.md content
response = model.generate_content(
    "Run /product-comparison for Ahrefs vs SEMrush affiliate programs."
)
```

Swap skill SKILL.md files into context dynamically to run different skill workflows via the API.

---

## Tips

- **Web browsing + API calls**: Gemini Advanced's web browsing capability can reach
  `list.affitor.com/api/v1` endpoints — enable it for skills that require live program data
- **Large context window**: Gemini 2.0 handles 1M tokens — upload the entire skills directory
  contents if needed, Gemini won't truncate
- **Gems (Gemini's custom agents)**: Create a Gem with `bootstrap.md` as its instructions and
  the key files uploaded — equivalent to ChatGPT's Custom GPT setup
- **Output formatting**: ask Gemini to output in markdown for blog posts, or JSON for structured
  data skills — it follows format instructions reliably
- **Chaining skills**: Gemini maintains context well across a long conversation — run
  `/content-brief` first, then `/blog-post`, then `/meta-description` without re-loading context
