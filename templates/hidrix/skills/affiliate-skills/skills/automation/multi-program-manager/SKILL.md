---
name: multi-program-manager
description: >
  Manage and compare multiple affiliate programs as a portfolio. Triggers on:
  "manage my affiliate programs", "compare my programs", "portfolio overview",
  "which program should I focus on", "diversify my affiliate income",
  "program switching", "affiliate portfolio", "program comparison",
  "revenue allocation", "which programs to drop", "add new programs",
  "affiliate program strategy".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "automation", "scaling", "workflow", "portfolio", "multi-program"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S7-Automation
---

# Multi-Program Manager

Manage and compare multiple affiliate programs as a portfolio — overview, performance comparison, diversification strategy, program switching decisions, and revenue allocation. Output is a portfolio dashboard with strategic recommendations and a weekly action plan.

## Stage

S7: Automation — Most affiliates either promote too few programs (concentration risk) or too many (effort dilution). This skill applies portfolio thinking to affiliate marketing: analyze your programs like investments, identify which to double down on, maintain, or drop, and allocate your limited time for maximum ROI.

## When to Use

- User manages multiple affiliate programs and wants a strategic overview
- User asks "which program should I focus on?" or "should I drop this program?"
- User wants to diversify their affiliate income
- User says "compare my programs", "portfolio review", "program strategy"
- User is deciding whether to add or remove programs
- Chaining from S6.3 (performance-report): take performance data and make strategic decisions

## Input Schema

```yaml
programs:
  - name: string # REQUIRED — program name
    affiliate_url: string # OPTIONAL — affiliate link
    reward_value: string # OPTIONAL — commission (e.g., "30% recurring")
    reward_type: string # OPTIONAL — "cps_recurring" | "cps_one_time" | "cpl" | "cpc"
    monthly_revenue: number # OPTIONAL — avg monthly revenue ($)
    monthly_clicks: number # OPTIONAL — avg monthly clicks
    niche: string # OPTIONAL — product category
    status: string # OPTIONAL — "active" | "paused" | "new" | "considering"

goal:
  string # OPTIONAL — "maximize_revenue" | "diversify"
  # | "reduce_risk" | "find_gaps"
  # Default: "maximize_revenue"

budget_hours:
  number # OPTIONAL — weekly hours available for content
  # Default: 10
```

**Chaining context**: If S1 program research or S6.3 performance data exists in conversation, pull program details and metrics automatically.

## Workflow

### Step 1: Build Portfolio Overview

Compile all programs into a dashboard:

- Program name, niche, commission type, commission value
- Monthly revenue, clicks, EPC
- Status (active/paused/new)
- Revenue share (% of total)

### Step 2: Calculate Per-Program Metrics

For each program with data:

- **EPC**: revenue / clicks
- **Revenue Share**: program revenue / total revenue × 100
- **Effort-to-Revenue Ratio**: estimated hours spent / revenue generated
- **Commission Quality Score**: recurring > one-time > per-lead > per-click

### Step 3: Apply Portfolio Analysis

**Concentration Risk**:

- If top program > 50% of revenue → HIGH RISK
- If top 2 programs > 80% → MODERATE RISK
- If no program > 30% → WELL DIVERSIFIED

**Niche Overlap**:

- Multiple programs in same niche → competing for same audience
- Different niches → healthy diversification

**Revenue Stability**:

- Recurring commissions → stable
- One-time commissions → volatile (need constant new traffic)

### Step 4: Generate Recommendations

For each program, assign an action:

- **Double Down**: High EPC, room to grow → create more content, scale traffic
- **Maintain**: Solid performer, no changes needed → keep existing content fresh
- **Optimize**: High traffic but low conversion → improve CTAs, landing pages, test variants
- **Phase Out**: Low EPC, low growth potential → redirect effort to better programs
- **Add**: Gap identified → research new programs with S1

### Step 5: Create Action Plan

Based on `budget_hours`, allocate weekly time:

- Double-down programs get 50% of time
- Maintain programs get 20%
- Optimize programs get 20%
- New program research gets 10%

Provide specific weekly tasks tied to Affitor skills.

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] Revenue share percentages sum to ~100%
- [ ] EPC calculations correct (revenue ÷ clicks per program)
- [ ] Concentration risk accurate (flag if top program >50% of revenue)
- [ ] Actions match performance: double_down (Star), maintain (Cash Cow), optimize (Question Mark), phase_out (Dog)
- [ ] Weekly time allocation sums to user's stated hours budget

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
portfolio:
  total_programs: number
  active_programs: number
  total_monthly_revenue: number
  concentration_risk: string # "high" | "moderate" | "low"
  niche_diversification: string # "good" | "overlapping" | "single_niche"
  revenue_stability: string # "stable" | "moderate" | "volatile"

programs:
  - name: string
    niche: string
    reward_type: string
    monthly_revenue: number
    epc: number
    revenue_share: number
    action: string # "double_down" | "maintain" | "optimize" | "phase_out"
    reason: string

recommendations:
  - action: string
    program: string
    skill: string # which Affitor skill to use
    task: string # specific task
    priority: number # 1 = highest

weekly_plan:
  total_hours: number
  allocation:
    - program: string
      hours: number
      tasks: string[]
```

## Output Format

1. **Portfolio Dashboard** — table with all programs, revenue, EPC, revenue share
2. **Portfolio Health** — concentration risk, diversification, stability assessment
3. **Program Scorecards** — per-program action (double down / maintain / optimize / phase out) with reason
4. **Strategic Recommendations** — prioritized list of actions with Affitor skill references
5. **Weekly Action Plan** — hour-by-hour allocation with specific tasks

## Error Handling

- **Only one program**: "You have a single program. That's 100% concentration risk. I'll analyze it and recommend 2-3 complementary programs using S1 (affiliate-program-search)."
- **No revenue data**: "Without revenue data, I'll analyze based on commission structure and niche overlap. For deeper analysis, run S6.3 (performance-report) first to get your numbers."
- **All programs in same niche**: "All your programs are in [niche]. You're diversified by product but not by market. If [niche] declines, all your income is at risk. Consider adding programs in adjacent niches."

## Examples

### Example 1: Portfolio with clear winner

**User**: "I promote HeyGen ($450/mo), Semrush ($320/mo), Notion ($125/mo), Canva ($80/mo). Which should I focus on?"
**Action**: HeyGen is the star (46% revenue, likely highest EPC). Recommend: Double down on HeyGen (more blog content, S7 content-repurposer). Maintain Semrush. Optimize Notion (high conversion rate potential). Evaluate Canva (low revenue, is it worth the effort?). Weekly plan: 5h HeyGen, 2h Semrush, 2h Notion, 1h research.

### Example 2: Diversification analysis

**User**: "I make $2K/month from 3 SaaS tools. How do I reduce risk?"
**Action**: All income from one niche (SaaS) = moderate risk. Recommend: Add 1-2 programs in adjacent niches (e.g., online courses, hosting). Check commission types — if all one-time, recommend adding recurring programs. Use S1 to research programs in new niches.

### Example 3: Program switching decision

**User**: "Should I drop Canva ($80/mo, 500 clicks) and replace it with Jasper?"
**Action**: Canva EPC = $0.16 (low). Calculate opportunity cost: 500 clicks redirected to a $0.50+ EPC program = $250/mo potential. Research Jasper commission (likely $100+ per sale). Recommend: Yes, switch. Use S1 to evaluate Jasper, then S3 for a comparison blog post.

## References

- `shared/references/affiliate-glossary.md` — Portfolio and commission terminology. Referenced in Step 2.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `commission-calculator` (S1) — managed programs for portfolio calculation
- `funnel-planner` (S8) — portfolio data for funnel planning

### Fed By

- `affiliate-program-search` (S1) — new programs to add to portfolio
- `conversion-tracker` (S6) — performance data per program
- `performance-report` (S6) — portfolio performance trends

### Feedback Loop

- `performance-report` (S6) reveals underperforming programs → recommend swaps or investment reallocation

```yaml
chain_metadata:
  skill_slug: "multi-program-manager"
  stage: "automation"
  timestamp: string
  suggested_next:
    - "commission-calculator"
    - "performance-report"
    - "affiliate-program-search"
```
