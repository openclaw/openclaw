# affiliate-skills

**Turn any AI into your affiliate marketing team.**

45 AI-powered skills across 8 stages with a closed-loop flywheel. Research programs, write content, build pages, deploy, track, optimize, scale — with any AI agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Skills](https://img.shields.io/badge/skills-45-brightgreen)](skills/)
[![Standard](https://img.shields.io/badge/standard-agentskills.io-purple)](https://agentskills.io)

Works with: **Claude Code** · **ChatGPT** · **Gemini CLI** · **Cursor** · **Windsurf** · **OpenClaw** · **any AI that reads text**

### Install

```bash
# Claude Code (recommended)
npx skills add Affitor/affiliate-skills

# Or clone manually
git clone https://github.com/Affitor/affiliate-skills.git ~/.claude/skills/affiliate-skills
cd ~/.claude/skills/affiliate-skills && ./setup

# OpenClaw / ClawHub
clawhub install affiliate-skills

# Cursor / Windsurf
npx skills add Affitor/affiliate-skills
```

### Try it now — no install needed

Paste this into any AI:

```
Search the Affitor affiliate directory for AI video tools.
Use this API: GET https://list.affitor.com/api/v1/programs?q=AI+video&sort=top&limit=5
Show me the results in a table with: Name, Commission, Cookie Duration, Stars.
Then recommend the best one and explain why.
```

### Without affiliate-skills

- You Google "best affiliate programs" and get SEO spam written to rank, not to help
- You write a blog review and guess if the CTA, headline, or disclosure is any good
- You have no idea which content actually drives clicks — you just hope
- You spend 4 hours on a landing page that converts at 0.2%
- You pick programs by vibes instead of data

### With affiliate-skills

| Skill                                | Mode         | What it does                                                                 |
| ------------------------------------ | ------------ | ---------------------------------------------------------------------------- |
| Program Search                       | Data analyst | Live program data from list.affitor.com — commissions, cookies, comparisons. |
| Research                             | Scout        | Score and rank programs. Find the best one for your niche.                   |
| Funnel Planner                       | Strategist   | Week-by-week roadmap from zero to revenue. Chain skills automatically.       |
| Content, Blog, Landing, Distribution | Creator      | 20 skills that write posts, articles, pages, and deploy them.                |
| Analytics, Automation                | Optimizer    | Track conversions, A/B test, repurpose content, scale what works.            |
| Compliance, Self-improver            | Safety net   | FTC audit before you publish. Retrospective after you launch.                |

## Demo: zero to first commission

```
You:  I want to promote AI video tools. What's the best program?

AI:   [queries list.affitor.com API]

       Name                      Commission           Cookie     Stars
       ─────────────────────────────────────────────────────────────────
       HeyGen                    30% recurring        60 days    ★ 127
       Synthesia                 25% one-time         30 days    ★ 84
       D-ID                      20% recurring        45 days    ★ 52

      HeyGen is the clear winner: highest commission, recurring, longest
      cookie. Let me research it in depth.

You:  Write a blog review of HeyGen for content creators.

AI:   [runs affiliate-blog-builder skill]
      [2,000-word SEO review with pros/cons, comparison table,
       FTC disclosure, and affiliate CTA]

You:  Create a landing page for this.

AI:   [runs landing-page-creator skill]
      [single-file HTML/CSS page, AIDA framework, mobile-responsive,
       ready to deploy]

You:  Plan my full funnel — I have 5 hours/week and I blog.

AI:   [runs funnel-planner skill]

      Week 1: Research (affiliate-program-search) → select 2-3 programs
      Week 2: Content (viral-post-writer) → 5 LinkedIn + Twitter posts
      Week 3: Blog (affiliate-blog-builder) → 1 review article
      Week 4: Deploy (bio-link-deployer) → bio link page live
      Week 5: Analytics (seo-audit) → fix SEO issues
      Week 6: Optimize (ab-test-generator) → test headlines

      Success metric: first affiliate click by week 3, first commission
      by week 6.
```

## Who this is for

You want to do affiliate marketing with AI — not by hand. You want data-driven program selection, not guesswork. You want content that converts, not content that exists.

This is not a prompt pack for beginners. It is an operating system for affiliates who ship.

## Get Started

> **[QUICKSTART.md](QUICKSTART.md)** — Platform-specific setup for Claude Code, ChatGPT, Cursor, Gemini, and more.

### Fastest way (any AI, no install)

1. Copy the [bootstrap prompt](prompts/bootstrap.md) (everything below the `---` line)
2. Paste it into your AI
3. Start: _"Find me the best SaaS affiliate programs with recurring commission"_

### Claude Code (full integration)

```bash
git clone https://github.com/Affitor/affiliate-skills.git ~/.claude/skills/affiliate-skills
cd ~/.claude/skills/affiliate-skills && ./setup
```

Then tell Claude to add affiliate-skills to your project's CLAUDE.md. You get slash commands, the `affiliate-check` CLI, and automatic skill discovery.

### ChatGPT / Gemini / Any AI

1. Copy [`prompts/bootstrap.md`](prompts/bootstrap.md) into your conversation or project instructions
2. Optionally upload [`registry.json`](registry.json) and [`API.md`](API.md) as knowledge files
3. Done — your AI is now an affiliate marketing agent

### Cursor / Windsurf

```bash
git clone https://github.com/Affitor/affiliate-skills.git
```

Open the folder — `.cursorrules` configures the AI automatically.

---

## The Affiliate Flywheel — 8 Stages, 45 Skills

```
  S1 RESEARCH ──▶ S2 CONTENT ──▶ S3 BLOG & SEO ──▶ S4 OFFERS & LANDING
       ▲                                                    │
       │                                                    ▼
       │                                              S5 DISTRIBUTION
       │                                                    │
       └──────────── S6 ANALYTICS ◀─────────────────────────┘
                          │
                          ▼
                    S7 AUTOMATION → SCALE
                          │
                    S8 META (across all)
```

**Flywheel**: S6 Analytics feeds BACK to S1 Research → closed loop. Every skill knows what comes next (`chain_metadata.suggested_next`) and what feeds it. Data flows forward through the funnel and back through analytics.

### S1: Research & Discovery (6 skills)

Find and evaluate the best affiliate programs to promote.

| Skill                                                                 | Description                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| [affiliate-program-search](skills/research/affiliate-program-search/) | Research and score programs from list.affitor.com            |
| [niche-opportunity-finder](skills/research/niche-opportunity-finder/) | Find underserved niches with high potential                  |
| [competitor-spy](skills/research/competitor-spy/)                     | Analyze competitor affiliate strategies                      |
| [commission-calculator](skills/research/commission-calculator/)       | Calculate and compare commission structures                  |
| [monopoly-niche-finder](skills/research/monopoly-niche-finder/)       | Find intersection niches where you're the ONLY voice (Thiel) |
| [purple-cow-audit](skills/research/purple-cow-audit/)                 | Score product remarkability 1-10 before promoting (Godin)    |

### S2: Content Creation (5 skills)

Write viral social media content that drives clicks.

| Skill                                                              | Description                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| [viral-post-writer](skills/content/viral-post-writer/)             | LinkedIn, X, Reddit, Facebook posts                    |
| [twitter-thread-writer](skills/content/twitter-thread-writer/)     | Multi-tweet threads with hooks                         |
| [reddit-post-writer](skills/content/reddit-post-writer/)           | Authentic Reddit posts with disclosure                 |
| [tiktok-script-writer](skills/content/tiktok-script-writer/)       | Short-form video scripts                               |
| [content-pillar-atomizer](skills/content/content-pillar-atomizer/) | 1 article → 15-30 platform-native micro-content pieces |

### S3: Blog & SEO (7 skills)

Long-form SEO-optimized articles that rank and convert.

| Skill                                                               | Description                                        |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| [affiliate-blog-builder](skills/blog/affiliate-blog-builder/)       | Full review and how-to articles                    |
| [comparison-post-writer](skills/blog/comparison-post-writer/)       | Head-to-head product comparisons                   |
| [listicle-generator](skills/blog/listicle-generator/)               | "Top N" roundup articles                           |
| [how-to-tutorial-writer](skills/blog/how-to-tutorial-writer/)       | Tutorial articles with product integration         |
| [keyword-cluster-architect](skills/blog/keyword-cluster-architect/) | Map 50-200+ keywords into topical clusters         |
| [content-moat-calculator](skills/blog/content-moat-calculator/)     | Estimate pages needed for topical authority        |
| [content-decay-detector](skills/blog/content-decay-detector/)       | Monitor content for ranking drops, trigger refresh |

### S4: Offers & Landing Pages (8 skills)

Irresistible offers and high-converting pages — pure HTML/CSS, no dependencies.

| Skill                                                                  | Description                             |
| ---------------------------------------------------------------------- | --------------------------------------- |
| [landing-page-creator](skills/landing/landing-page-creator/)           | AIDA-framework landing pages            |
| [product-showcase-page](skills/landing/product-showcase-page/)         | Single-product showcase                 |
| [squeeze-page-builder](skills/landing/squeeze-page-builder/)           | Lead capture pages                      |
| [webinar-registration-page](skills/landing/webinar-registration-page/) | Event-based promotion                   |
| [grand-slam-offer](skills/landing/grand-slam-offer/)                   | Hormozi Value Equation offer design     |
| [bonus-stack-builder](skills/landing/bonus-stack-builder/)             | Exclusive bonus packages for YOUR link  |
| [guarantee-generator](skills/landing/guarantee-generator/)             | Personal guarantees for risk reversal   |
| [value-ladder-architect](skills/landing/value-ladder-architect/)       | Free → tripwire → core → upsell journey |

### S5: Distribution & Deployment (4 skills)

Get your content live and distributed.

| Skill                                                                 | Description                   |
| --------------------------------------------------------------------- | ----------------------------- |
| [bio-link-deployer](skills/distribution/bio-link-deployer/)           | Linktree alternative you own  |
| [email-drip-sequence](skills/distribution/email-drip-sequence/)       | 5-7 email nurture sequence    |
| [social-media-scheduler](skills/distribution/social-media-scheduler/) | Posting schedule and calendar |
| [github-pages-deployer](skills/distribution/github-pages-deployer/)   | Deploy to GitHub Pages        |

### S6: Analytics & Optimization (5 skills)

Track, measure, optimize — and feed data back to S1.

| Skill                                                                      | Description                              |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| [conversion-tracker](skills/analytics/conversion-tracker/)                 | UTM links, tracking pixels, attribution  |
| [ab-test-generator](skills/analytics/ab-test-generator/)                   | A/B test variants for headlines and CTAs |
| [performance-report](skills/analytics/performance-report/)                 | Weekly/monthly KPI reports               |
| [seo-audit](skills/analytics/seo-audit/)                                   | 10-dimension SEO scorecard               |
| [internal-linking-optimizer](skills/analytics/internal-linking-optimizer/) | Hub-and-spoke internal link structure    |

### S7: Automation & Scale (5 skills)

Automate workflows and scale what's working.

| Skill                                                                       | Description                              |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| [email-automation-builder](skills/automation/email-automation-builder/)     | Branching email flows with conditions    |
| [content-repurposer](skills/automation/content-repurposer/)                 | One piece of content → multiple formats  |
| [multi-program-manager](skills/automation/multi-program-manager/)           | Affiliate program portfolio strategy     |
| [paid-ad-copy-writer](skills/automation/paid-ad-copy-writer/)               | Ad copy for Facebook, Google, TikTok     |
| [proprietary-data-generator](skills/automation/proprietary-data-generator/) | Original surveys, benchmarks, data moats |

### S8: Meta (5 skills)

Cross-cutting skills for discovery, planning, compliance, and strategy.

| Skill                                                 | Description                                   |
| ----------------------------------------------------- | --------------------------------------------- |
| [skill-finder](skills/meta/skill-finder/)             | Find the right skill for any goal             |
| [funnel-planner](skills/meta/funnel-planner/)         | Plan a complete affiliate funnel roadmap      |
| [compliance-checker](skills/meta/compliance-checker/) | FTC compliance and platform rules audit       |
| [self-improver](skills/meta/self-improver/)           | Campaign retrospective and improvement plan   |
| [category-designer](skills/meta/category-designer/)   | Define a new category where your product wins |

---

Machine-readable index: [`registry.json`](registry.json) · API docs: [`API.md`](API.md) · Skill template: [`template/SKILL.md`](template/SKILL.md) · Spec: [`spec/`](spec/)

## How it works

Each skill is a single Markdown file (`SKILL.md`) that tells any AI exactly how to execute a specific affiliate marketing task. Skills define:

- **When to trigger** — natural language patterns that activate the skill
- **Input/Output schemas** — structured data for agent interop
- **Workflow** — step-by-step procedure with decision points
- **Chaining** — how outputs from one skill feed into the next

Skills pass data through conversation context, not files. Run S1 to find a program, then S2 uses that program's data automatically — no copy-pasting.

## Entry points

You don't have to start from S1. Jump in wherever you are:

- **New to affiliate marketing:** S8 `funnel-planner` → it plans everything for you
- **Have a product already:** S2 (write content) or S3 (write a review)
- **Have content, need pages:** S4 (landing page) or S5 (bio link)
- **Want to optimize:** S6 (analytics + SEO audit)
- **Ready to scale:** S7 (automation + paid ads)
- **Not sure which skill:** S8 `skill-finder`

## For Developers

Building an agent pipeline? Here's what you need:

- **[`registry.json`](registry.json)** — machine-readable index of all 45 skills with metadata
- **[`API.md`](API.md)** — full REST API documentation for list.affitor.com
- **[`prompts/bootstrap.md`](prompts/bootstrap.md)** — system prompt that bootstraps the full agent
- **`agents/openai.yaml`** — OpenAI-compatible tool definitions (in skills that have them)
- **Input/Output schemas** — every SKILL.md has typed schemas for structured data exchange

## Contributing

We welcome skills from the community. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to submit your own skill.

Every merged skill gets published to [list.affitor.com/skills](https://list.affitor.com/skills).

## License

MIT

---

Built by [Affitor](https://affitor.com). Directory: [list.affitor.com](https://list.affitor.com)
