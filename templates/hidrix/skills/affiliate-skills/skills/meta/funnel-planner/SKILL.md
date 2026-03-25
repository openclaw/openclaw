---
name: funnel-planner
description: >
  Plan a complete affiliate funnel from research to revenue. Triggers on:
  "plan my affiliate funnel", "create a funnel strategy", "affiliate business plan",
  "how to start affiliate marketing", "full funnel roadmap", "plan from scratch",
  "week by week affiliate plan", "chain skills together", "build my funnel",
  "affiliate marketing roadmap", "step by step affiliate plan", "onboarding plan".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "meta", "planning", "compliance", "funnel", "strategy"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S8-Meta
---

# Funnel Planner

Plan a complete affiliate funnel from research to revenue by chaining Affitor skills into a week-by-week execution roadmap. Output is a Markdown plan with skill sequence, time estimates, and exact invocation prompts for each step.

## Stage

S8: Meta — Most affiliates fail because they skip steps or work out of order. Funnel Planner solves this by mapping the user's resources (time, channels, experience) to a personalized execution plan that chains S1-S7 skills in the right sequence. It's the onboarding wizard for affiliate marketing via AI agent.

## When to Use

- User is starting from scratch and wants a complete plan
- User asks "how do I start affiliate marketing?"
- User has a niche but no strategy
- User wants to know which skills to use and in what order
- User says "build me a funnel" or "plan my affiliate business"
- User wants a week-by-week roadmap
- Chaining: this skill recommends which other skills to run and in what order

## Input Schema

```yaml
niche:
  string # OPTIONAL — e.g., "AI tools", "fitness supplements"
  # If not provided, S1 research will help identify one

product:
  string # OPTIONAL — specific product if already chosen
  # e.g., "HeyGen" or "Semrush"

experience_level:
  string # OPTIONAL — "beginner" | "intermediate" | "advanced"
  # Default: "beginner"

available_channels: # OPTIONAL — platforms the user can use
  - string # e.g., ["blog", "twitter", "linkedin", "email"]
    # Default: ["blog", "twitter"]

weekly_hours:
  number # OPTIONAL — hours per week available
  # Default: 5

goal:
  string # OPTIONAL — "first_commission" | "scale_to_1k" | "scale_to_10k"
  # Default: "first_commission"
```

**Chaining context**: If S1 was run earlier, pull niche and product info from conversation. If the user has mentioned their channels or experience, use that context.

## Workflow

### Step 1: Assess Starting Point

Determine where the user is:

- **Has nothing**: Start from S1 (full funnel)
- **Has a product**: Skip S1, start from S2
- **Has content**: Skip S1-S2, start from S3 or S4
- **Has traffic**: Skip to S6 (analytics) or S7 (automation)

Ask clarifying questions only if truly ambiguous. Default to the most common case (beginner, starting from scratch).

### Step 2: Select Relevant Skills

Based on channels, experience, and goal, select 5-8 skills from S1-S7:

- **Beginner + blog + twitter**: S1 → S2 (viral-post-writer) → S3 (affiliate-blog-builder) → S5 (bio-link-deployer) → S6 (seo-audit)
- **Intermediate + email + blog**: S1 → S3 → S4 (landing-page-creator) → S5 (email-drip-sequence) → S6 (performance-report) → S7 (content-repurposer)
- **Advanced + all channels**: Full S1-S7 pipeline with S8 (compliance-checker) at each content step

### Step 3: Estimate Effort

For each selected skill, estimate time based on experience level:

- Beginner: 2-4 hours per skill
- Intermediate: 1-2 hours per skill
- Advanced: 30-60 minutes per skill

Fit into the user's `weekly_hours` to create a week-by-week schedule.

### Step 4: Create Roadmap

Build a week-by-week table:

- Week number
- Skill to run
- What it produces
- Time estimate
- Exact prompt to invoke the skill

### Step 5: Add Success Metrics

For each phase, define measurable outcomes:

- S1: "You should have 2-3 programs selected"
- S2: "You should have 5+ social posts ready"
- S3: "You should have 1-2 blog posts published"
- S5: "You should have a bio link page live"
- S6: "You should know your EPC and conversion rate"

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] Roadmap follows logical sequence (S1→S2→S3... not random order)
- [ ] Invocation prompts are copy-paste ready for each skill
- [ ] Time estimates realistic for stated experience level
- [ ] Success metrics are measurable and specific (not "do well")
- [ ] Total weeks feasible given user's weekly hours budget

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
plan:
  niche: string
  product: string
  experience: string
  goal: string
  total_weeks: number
  total_skills: number

roadmap:
  - week: number
    skill: string # skill slug
    stage: string # e.g., "S1: Research"
    action: string # what to do this week
    time_estimate: string # e.g., "2-3 hours"
    invocation_prompt: string # exact prompt to give your AI agent
    success_metric: string # how to know this step is done

milestones:
  - week: number
    name: string # e.g., "First content published"
    description: string
```

## Output Format

1. **Plan Overview** — niche, goal, timeline, total skills
2. **Week-by-Week Roadmap** — table with week, skill, action, time, and prompt
3. **Milestones** — key checkpoints with expected outcomes
4. **Entry Points** — where to jump in if user is not starting from scratch

## Error Handling

- **No niche or product**: "Let's find your niche first. I'll plan a funnel that starts with S1 (affiliate-program-search) to discover the best programs for you. What topics interest you? (e.g., AI tools, fitness, finance)"
- **Unrealistic time commitment ("1 hour total")**: "Building a profitable affiliate funnel takes sustained effort. With 1 hour/week, I'd focus on one channel. Here's a minimal plan using just S1 + S2 (social posts only)."
- **Too many channels for experience level**: "You listed 6 channels but you're a beginner. I'd recommend starting with 2 (blog + one social platform) and adding more after your first commission."

## Examples

### Example 1: Complete beginner

**User**: "I want to start affiliate marketing. I have 5 hours a week and I blog."
**Action**: Plan a 6-week funnel: Week 1 S1 (find programs) → Week 2 S2 (write social posts) → Week 3-4 S3 (write blog review) → Week 5 S5 (bio link page) → Week 6 S6 (SEO audit + tracking). Include exact prompts for each skill.

### Example 2: Intermediate with product

**User**: "I already promote Semrush. How do I scale to $1K/month?"
**Action**: Skip S1. Plan around optimization: S6 (performance-report to baseline) → S6 (ab-test-generator for existing content) → S7 (content-repurposer to multiply what works) → S7 (email-automation-builder for nurture) → S6 (performance-report again to measure).

### Example 3: Advanced multi-channel

**User**: "I'm an experienced affiliate with blog, YouTube, and email. Plan me a full funnel for AI tools."
**Action**: Compressed 4-week plan using all stages. Week 1: S1 (research) + S2 (content blitz). Week 2: S3 (blog) + S4 (landing page). Week 3: S5 (distribution) + S7 (content-repurposer). Week 4: S6 (analytics setup) + S8 (compliance-checker). Ongoing: S8 (self-improver) monthly.

## References

- `registry.json` — Skill catalog for selecting the right skills. Read in Step 2.
- `docs/affiliate-funnel-overview.md` — Funnel stage descriptions. Read in Step 2.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- All skills (S1-S7) — `roadmap` provides week-by-week execution plan chaining specific skills

### Fed By

- `commission-calculator` (S1) — commission projections inform funnel ROI estimates
- `value-ladder-architect` (S4) — value ladder informs the funnel structure
- `multi-program-manager` (S7) — portfolio data for planning
- `performance-report` (S6) — performance baselines for goal-setting
- `category-designer` (S8) — category framing shapes the funnel narrative

### Feedback Loop

- `performance-report` (S6) tracks funnel progress vs plan → adjust skill sequence and timeline based on actual results

```yaml
chain_metadata:
  skill_slug: "funnel-planner"
  stage: "meta"
  timestamp: string
  suggested_next:
    - "affiliate-program-search"
    - "viral-post-writer"
    - "affiliate-blog-builder"
    - "landing-page-creator"
```
