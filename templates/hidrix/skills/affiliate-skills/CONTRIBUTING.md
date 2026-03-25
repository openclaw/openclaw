# Contributing to Affiliate Skills

Thanks for contributing! This guide explains how to add your own skill to the collection.

## How Skills Are Organized

Skills live in stage directories under `skills/`:

```
skills/
├── research/          S1: Find and evaluate programs
├── content/           S2: Create promotional content
├── blog/              S3: Write SEO articles
├── landing/           S4: Build conversion pages
├── distribution/      S5: Deploy and distribute
├── analytics/         S6: Track and optimize
├── automation/        S7: Automate and scale
└── meta/              S8: Plan, comply, improve
```

| Stage            | Focus                      | Example Skills                                         |
| ---------------- | -------------------------- | ------------------------------------------------------ |
| S1: Research     | Find and evaluate programs | `affiliate-program-search`, `niche-opportunity-finder` |
| S2: Content      | Create promotional content | `viral-post-writer`, `tiktok-script-writer`            |
| S3: Blog         | Write SEO articles         | `affiliate-blog-builder`, `comparison-post-writer`     |
| S4: Landing      | Build conversion pages     | `landing-page-creator`, `product-showcase-page`        |
| S5: Distribution | Deploy and distribute      | `bio-link-deployer`, `github-pages-deployer`           |
| S6: Analytics    | Track and optimize         | `conversion-tracker`, `seo-audit`                      |
| S7: Automation   | Automate and scale         | `content-repurposer`, `email-automation-builder`       |
| S8: Meta         | Plan, comply, improve      | `funnel-planner`, `compliance-checker`                 |

Pick a stage, build a skill.

## Creating a New Skill

### 1. Fork and clone

```bash
git clone https://github.com/affitor/affiliate-skills.git
cd affiliate-skills
```

### 2. Scaffold your skill

Pick a stage and create the directory:

```bash
# Replace {stage} with: research, content, blog, landing, distribution, analytics, automation, or meta
mkdir -p skills/{stage}/your-skill-name/references
cp template/SKILL.md skills/{stage}/your-skill-name/SKILL.md
cp LICENSE skills/{stage}/your-skill-name/LICENSE.txt
```

Naming convention: `kebab-case`, `verb-noun` format (e.g., `viral-post-writer`, `affiliate-blog-builder`).

### 3. Write your skill

Fill in `SKILL.md` with:

- **Frontmatter:** name and a pushy description (cover multiple trigger phrases)
- **Input Schema:** what the skill needs (required vs optional fields)
- **Workflow:** step-by-step what the skill does
- **Output Schema:** structured output for agent chaining
- **Output Format:** human-readable output (tables, markdown, HTML)
- **Error Handling:** what to do when things go wrong
- **Examples:** at least 2 realistic prompts with expected output summaries

If any reference content exceeds 50 lines, put it in `references/` as a separate file.

### 4. Test your skill

Run these three tests:

1. **Stranger test:** Someone who's never heard of Affitor types a natural prompt. Does the output make sense?
2. **Chain test:** Paste the output into a new conversation. Can the next skill in the funnel understand it?
3. **Platform test:** Copy the output outside your AI. Does it work? (Post to X, deploy to Vercel, paste into WordPress)

### 5. Submit a PR

- Create your skill in `skills/{stage}/[skill-name]/`
- Include: `SKILL.md` + `references/` + 3 test prompts in PR description
- PR description: which stage, what it does, test results

## Quality Checklist

Before submitting, verify:

- [ ] `SKILL.md` has frontmatter with `name` and `description`
- [ ] Description is pushy — covers 5+ trigger phrases
- [ ] At least 2 examples with realistic prompts
- [ ] References in separate files if >50 lines
- [ ] Output is portable (user can use it immediately outside the AI)
- [ ] Tested in at least 2 different AI platforms (e.g., Claude + ChatGPT, or Cursor + Gemini)
- [ ] Includes affiliate disclosure guidance
- [ ] Works standalone (no dependency on other skills)
- [ ] Works in chain (picks up context from conversation if available)
- [ ] Input Schema and Output Schema defined
- [ ] Error handling covers common failure modes
- [ ] Tested with 3 different prompts

## After Merge

Your skill will be automatically added to `registry.json` via CI and published to [list.affitor.com/skills](https://list.affitor.com/skills). You'll be credited as the author.

See [`spec/`](spec/) for the full skill format specification.

## Questions?

Open an issue or reach out on [list.affitor.com](https://list.affitor.com).
