---
title: "I Built 45 AI Agent Skills for Affiliate Marketing — Here's How They Work"
published: false
description: "Open-source skill collection that turns any AI into an affiliate marketing team. Full funnel coverage with a closed-loop flywheel."
tags: showdev, ai, opensource, affiliate
cover_image:
---

## The Problem

AI is great at writing copy. But ask it to "find the best affiliate program for AI video tools" and you get generic, outdated advice from its training data.

What if your AI could query a real-time database, compare commission rates, calculate potential earnings, then write optimized content — all in one conversation?

## What I Built

[affiliate-skills](https://github.com/Affitor/affiliate-skills) — 45 open-source AI agent skills that cover the entire affiliate marketing funnel:

| Stage            | Skills | What they do                         |
| ---------------- | ------ | ------------------------------------ |
| S1 Research      | 6      | Find and evaluate affiliate programs |
| S2 Content       | 5      | Write viral social media posts       |
| S3 Blog & SEO    | 7      | Build optimized blog content         |
| S4 Landing Pages | 8      | Create high-converting HTML pages    |
| S5 Distribution  | 4      | Deploy and schedule content          |
| S6 Analytics     | 5      | Track performance and optimize       |
| S7 Automation    | 5      | Scale what works                     |
| S8 Meta          | 5      | Plan, audit, improve the system      |

### The Flywheel

The key insight: skills chain together. S6 Analytics feeds data back to S1 Research, creating a closed optimization loop. Each skill has typed input/output schemas for agent interop.

### How It Works

Each skill is a `SKILL.md` file following the [agentskills.io](https://agentskills.io) open standard. The AI reads the file and gains structured knowledge about a specific workflow.

```bash
# Install (Claude Code)
npx skills add Affitor/affiliate-skills

# Or paste the bootstrap prompt into any AI
```

### Try It

Paste this into any AI:

```
Search the Affitor affiliate directory for AI video tools.
Use this API: GET https://list.affitor.com/api/v1/programs?q=AI+video&sort=top&limit=5
Show me the results in a table with: Name, Commission, Cookie Duration, Stars.
Then recommend the best one and explain why.
```

## Architecture

- **Standard:** agentskills.io (Anthropic, Linux Foundation AAIF)
- **Compatibility:** Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw
- **Data source:** list.affitor.com REST API
- **License:** MIT

## Links

- GitHub: https://github.com/Affitor/affiliate-skills
- Install: `npx skills add Affitor/affiliate-skills`
- Directory: https://list.affitor.com

---

What skills would you add? I'm looking for contributors to expand the collection.
