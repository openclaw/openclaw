---
name: self-improver
description: >
  Review affiliate campaign results and improve strategy. Triggers on:
  "review my results", "what went wrong", "how to improve conversions",
  "analyze my campaign", "affiliate retrospective", "why am I not converting",
  "improve my strategy", "what should I change", "campaign review",
  "optimize my approach", "learn from my results", "post-mortem on my campaign".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "meta", "planning", "compliance", "improvement", "feedback"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S8-Meta
---

# Self-Improver

Review affiliate campaign results, diagnose what worked and what didn't, and generate a prioritized improvement plan. Uses affiliate-specific diagnostic frameworks (offer-market fit, traffic-content match, funnel leak analysis) to identify root causes and actionable fixes.

## Stage

S8: Meta — Most affiliates repeat the same mistakes because they never do structured retrospectives. Self-Improver closes the feedback loop: it takes your results, compares them to expectations, diagnoses gaps using affiliate-specific frameworks, and produces concrete actions that feed back into S1-S7 for the next iteration.

## When to Use

- User has run a campaign and wants to understand results
- User's affiliate content isn't converting and wants to diagnose why
- User wants to compare actual vs expected results
- User says "what went wrong?", "why no conversions?", "how to improve?"
- User wants a structured retrospective on their affiliate efforts
- Chaining from S6.3 (performance-report) — analyze the data and plan improvements

## Input Schema

```yaml
campaign:
  description:
    string # REQUIRED — what was done (e.g., "Published 3 blog reviews
    # of AI video tools, shared on LinkedIn and Reddit")
  duration: string # OPTIONAL — how long (e.g., "2 weeks", "1 month")
  skills_used: string[] # OPTIONAL — which Affitor skills were used
  channels: string[] # OPTIONAL — where content was distributed

results:
  clicks: number # OPTIONAL — total clicks on affiliate links
  conversions: number # OPTIONAL — total signups/purchases
  revenue: number # OPTIONAL — total commission earned
  traffic: number # OPTIONAL — total page views / impressions
  feedback: string # OPTIONAL — qualitative feedback received

expectations:
  expected_clicks: number # OPTIONAL — what was expected
  expected_conversions: number # OPTIONAL
  expected_revenue: number # OPTIONAL
  benchmark: string # OPTIONAL — "industry average" or specific number

context:
  niche: string # OPTIONAL — product category
  experience: string # OPTIONAL — "first campaign" | "experienced"
  budget: string # OPTIONAL — money spent (if any)
```

**Chaining context**: If S6.3 (performance-report) was run in the same conversation, pull KPIs directly. If S1-S5 outputs exist in context, reference them for gap analysis.

## Workflow

### Step 1: Establish Baseline

Collect campaign description and results. If numbers are missing, work with whatever is available. State assumptions clearly: "You didn't share click data, so I'll focus on qualitative analysis."

### Step 2: Compare Results vs Expectations

Calculate gaps:

- **Traffic gap**: Expected vs actual impressions/visits
- **Click gap**: Expected vs actual CTR
- **Conversion gap**: Expected vs actual conversion rate
- **Revenue gap**: Expected vs actual earnings

Use industry benchmarks if user doesn't have expectations:

- Affiliate blog CTR: 2-5%
- Affiliate conversion rate: 1-3%
- Social post engagement: 1-3% of impressions
- Email click rate: 2-5%

### Step 3: Diagnose Root Causes

Apply affiliate-specific diagnostic frameworks:

**Offer-Market Fit**: Is the product right for the audience?

- Wrong audience for the product
- Product too expensive for the audience's budget
- Product solves a problem the audience doesn't have

**Traffic-Content Match**: Is the traffic source aligned with the content?

- Blog content promoted on TikTok (format mismatch)
- Reddit post that reads like an ad (platform mismatch)
- Cold traffic sent to a hard sell (temperature mismatch)

**Funnel Leaks**: Where do people drop off?

- High impressions but low clicks → weak headline/hook
- High clicks but low conversions → landing page or product issue
- High conversions but low revenue → wrong product (low commission)

### Step 4: Prioritize Improvements

Rank each improvement by:

- **Impact**: How much would this change move the needle? (1-5)
- **Effort**: How hard is it to implement? (1-5)
- **Priority**: Impact / Effort ratio

### Step 5: Create Iteration Plan

For each top improvement, specify:

- What to change
- Which Affitor skill to re-run
- Exact prompt modification for better results
- Expected improvement (realistic estimate)

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] Gap calculations accurate: expected minus actual
- [ ] Root causes are evidence-based, not speculation
- [ ] Impact (1-5) and effort (1-5) scores are justified with reasoning
- [ ] Next steps reference specific Affitor skills by name
- [ ] Iteration plan has concrete timeline and measurable success metric

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
retrospective:
  campaign: string
  period: string
  overall_assessment: string # "strong" | "average" | "needs_work" | "failing"

gaps:
  - metric: string # e.g., "conversion_rate"
    expected: string
    actual: string
    gap: string # e.g., "-2.5%"

diagnosis:
  root_causes:
    - cause: string # e.g., "Traffic-content mismatch"
      evidence: string # what indicates this
      severity: string # "high" | "medium" | "low"

improvements:
  - action: string # what to do
    skill: string # which Affitor skill to use
    prompt: string # exact prompt for the skill
    impact: number # 1-5
    effort: number # 1-5
    priority: number # impact / effort

iteration_plan:
  next_steps: string[] # ordered list of actions
  timeline: string # e.g., "1 week"
  success_metric: string # how to measure improvement
```

## Output Format

1. **Campaign Summary** — what was done, results achieved
2. **Gap Analysis** — table comparing expected vs actual metrics
3. **Root Cause Diagnosis** — what's causing the gaps, with evidence
4. **Improvement Actions** — prioritized table with action, skill, impact, effort
5. **Next Iteration Plan** — ordered steps with timeline and success metrics

## Error Handling

- **No results data at all**: "I need at least one data point to diagnose. Do you have: clicks, conversions, revenue, or even qualitative feedback (comments, reactions)? Even 'I got zero conversions' is useful data."
- **Only qualitative data**: Shift to qualitative analysis. "Without numbers, I'll focus on content quality, offer fit, and platform alignment. Here's what I can diagnose from your description."
- **Unrealistic expectations**: "You expected 100 sales from a single blog post in week 1. Industry average conversion rate is 1-3%, so 100 sales would require 3,000-10,000 clicks. Let me recalibrate your expectations and plan from there."

## Examples

### Example 1: Blog campaign with low conversions

**User**: "I wrote 3 blog reviews of AI tools last month. Got 2,000 visitors but only 2 conversions ($14 total). What went wrong?"
**Action**: Conversion rate 0.1% vs benchmark 1-3%. Diagnose: possible funnel leak (weak CTAs? disclosure too prominent? wrong products for audience?). Check traffic sources (SEO cold traffic needs more warming). Recommend: S6 (ab-test-generator) on CTAs, S6 (seo-audit) on content quality, S4 (landing-page-creator) as intermediate step.

### Example 2: Social campaign with zero clicks

**User**: "Posted 10 LinkedIn posts about Semrush. Lots of likes but nobody clicked my link."
**Action**: Traffic-content mismatch. LinkedIn engagement ≠ clicks. Diagnose: link placement (probably in comments where nobody looks), content may be too educational without clear CTA, audience may not be in buying mode on LinkedIn. Recommend: S2 (viral-post-writer) with CTA-focused brief, S3 (affiliate-blog-builder) to create destination content, S7 (content-repurposer) to adapt for click-friendly platforms.

### Example 3: Chained from performance-report

**Context**: S6.3 performance-report shows EPC of $0.02 across 5 programs, with one program at $0.15 EPC.
**User**: "How do I improve these numbers?"
**Action**: One program is 7x more profitable. Diagnose: concentrate effort on the winner. For the four underperformers, check offer-market fit (are these the wrong products?). Recommend: S7 (multi-program-manager) to restructure portfolio, S7 (content-repurposer) to create more content for the winning program, S6 (ab-test-generator) to optimize existing content.

## References

- `shared/references/ftc-compliance.md` — Referenced when reviewing content quality. Read in Step 3.
- `docs/affiliate-funnel-overview.md` — Funnel stage definitions for gap analysis. Read in Step 3.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- All skills — `improvement_suggestions` drive quality upgrades across the system

### Fed By

- `performance-report` (S6) — performance data revealing what needs improvement
- `conversion-tracker` (S6) — conversion trends for diagnosis
- `compliance-checker` (S8) — compliance issues to address

### Feedback Loop

- Each improvement cycle feeds back into the next self-improver run → track improvement trajectory over time

```yaml
chain_metadata:
  skill_slug: "self-improver"
  stage: "meta"
  timestamp: string
  suggested_next:
    - "funnel-planner"
    - "performance-report"
    - "skill-finder"
```
