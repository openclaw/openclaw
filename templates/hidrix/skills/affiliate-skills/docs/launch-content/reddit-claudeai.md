# Reddit r/ClaudeAI Post

**Title:** I built 45 Claude Code skills for affiliate marketing (open source)

**Body:**

I've been building a collection of AI agent skills focused on affiliate marketing. Just hit 45 skills across 8 stages — research, content, blog/SEO, landing pages, distribution, analytics, automation, and meta.

**Install:**

```
npx skills add Affitor/affiliate-skills
```

**What it does:**

Each skill teaches Claude Code a specific affiliate marketing workflow. They follow the agentskills.io standard and chain together — the output of one skill feeds into the next.

Example flow:

1. `/affiliate-program-search` — finds programs from a real-time database
2. `/viral-post-writer` — writes social content for the program
3. `/landing-page-creator` — builds a conversion-optimized HTML page
4. `/conversion-tracker` — sets up tracking
5. `/performance-report` — analyzes what's working

The analytics feed back into research, creating a closed optimization loop.

**Key features:**

- 45 skills with typed I/O schemas
- Real-time data from list.affitor.com API
- Built-in FTC compliance checking
- Works standalone or chained
- MIT licensed

Also works with ChatGPT, Gemini CLI, Cursor, Windsurf — any AI that reads text.

GitHub: https://github.com/Affitor/affiliate-skills

Looking for feedback and contributors. What skills would be most useful to add?
