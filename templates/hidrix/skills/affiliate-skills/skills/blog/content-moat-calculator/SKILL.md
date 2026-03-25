---
name: content-moat-calculator
description: >
  Estimate pages needed for topical authority. Go/no-go decision before investing months in content.
  Triggers on: "how much content do I need", "topical authority estimate", "content moat",
  "how many articles", "content gap analysis", "can I compete in this niche",
  "content investment calculator", "is this niche worth the effort", "SEO feasibility",
  "how many pages to rank", "content volume needed", "competitive content analysis",
  "moat calculation", "authority gap", "should I invest in this niche".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "content-moat", "authority"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# Content Moat Calculator

Estimate the total content investment needed to establish topical authority in a niche. Analyzes competitors' content volume and quality to give you a go/no-go decision before investing months of work. Answers the question: "How many pages do I need to dominate this topic?"

## Stage

S3: Blog & SEO — This decides what blog content to build. It's the feasibility check that saves you from starting a content strategy you can't finish.

## When to Use

- User is deciding whether to invest in a niche/topic
- User asks "how many articles do I need to rank?"
- User wants to understand the content investment required
- User says "content moat", "topical authority", "feasibility", "content gap"
- After `keyword-cluster-architect` to estimate effort for the planned clusters
- Before committing to a major content initiative

## Input Schema

```yaml
niche:
  string # REQUIRED — the topic to analyze
  # e.g., "AI video tools", "email marketing for SaaS"

hub_keyword:
  string # OPTIONAL — main keyword to analyze competitors for
  # Default: inferred from niche

your_current_pages:
  number # OPTIONAL — how many pages you already have on this topic
  # Default: 0

publishing_capacity:
  string # OPTIONAL — "1/week" | "2/week" | "3/week" | "5/week"
  # Default: "2/week"
```

**Chaining from S3 keyword-cluster-architect**: Use `keyword_clusters.total_clusters` and `keyword_clusters.hub.keyword`.

## Workflow

### Step 1: Analyze Top Competitors

Read `shared/references/seo-strategy.md` for moat calculation methodology.

1. `web_search` for `[hub_keyword]` or main niche keyword
2. Identify top 5 ranking sites (exclude giants like Wikipedia, Reddit)
3. For each competitor:
   - `web_search`: `site:[competitor.com] [niche topic]` — count pages on this topic
   - Note: content depth (word count), content freshness (publish dates), content types (blog, comparison, tutorial)

### Step 2: Calculate Moat

```
Average competitor pages = sum(competitor_pages) / number_of_competitors
Your moat target = Average × 1.5 (need MORE than average to break through)
Content gap = Moat target - your_current_pages
```

### Step 3: Feasibility Assessment

Based on moat target and publishing capacity:

```
Weeks to moat = Content gap / publishing_capacity_per_week
```

| Moat Target  | Assessment                | Recommendation                         |
| ------------ | ------------------------- | -------------------------------------- |
| < 20 pages   | GREEN — Achievable        | Go for it. 2-3 months at 2/week.       |
| 20-50 pages  | YELLOW — Significant      | Commit or don't. 3-6 months at 2/week. |
| 50-100 pages | ORANGE — Major investment | Consider narrowing niche. 6-12 months. |
| 100+ pages   | RED — Very high barrier   | Find a sub-niche or different angle.   |

### Step 4: Competitive Advantage Analysis

Identify ways to build moat FASTER:

1. **Quality over quantity**: Can you beat thin content with fewer, deeper pages?
2. **Unique data**: Can you add proprietary data competitors don't have? (→ `proprietary-data-generator`)
3. **Format advantage**: Can you use formats competitors don't? (video, interactive, tools)
4. **Update velocity**: Can you refresh content faster than competitors?

### Step 5: Timeline and Roadmap

Create realistic timeline:

- Phase 1: Foundation content (hub + core spokes)
- Phase 2: Supporting content (additional spokes, long-tail)
- Phase 3: Authority content (original research, data, comprehensive guides)
- Phase 4: Maintenance (refresh, update, expand)

### Step 6: Self-Validation

- [ ] Competitor analysis uses real data (not estimates)
- [ ] Moat calculation is transparent and logical
- [ ] Feasibility assessment is honest (not overly optimistic)
- [ ] Competitive advantages are realistic
- [ ] Timeline accounts for quality, not just quantity

## Output Schema

```yaml
output_schema_version: "1.0.0"
content_moat:
  niche: string
  hub_keyword: string
  competitors_analyzed: number
  average_competitor_pages: number
  moat_target: number
  your_current_pages: number
  content_gap: number
  feasibility: string # "green" | "yellow" | "orange" | "red"
  weeks_to_moat: number
  assessment: string # Go/no-go summary

  competitors:
    - domain: string
      pages_on_topic: number
      content_quality: string # "thin" | "average" | "deep"
      freshness: string # "stale" | "recent" | "actively updated"

  authority_gaps: string[] # What competitors have that you don't

  competitive_advantages: string[] # Ways to build moat faster

chain_metadata:
  skill_slug: "content-moat-calculator"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "affiliate-blog-builder"
    - "keyword-cluster-architect"
    - "proprietary-data-generator"
    - "content-decay-detector"
```

## Output Format

```
## Content Moat Analysis: [Niche]

### Competitor Landscape

| Competitor | Pages on Topic | Quality | Freshness |
|---|---|---|---|
| [domain] | XX | [thin/average/deep] | [stale/recent/active] |

### Moat Calculation
- **Average competitor pages:** XX
- **Your moat target (1.5x):** XX pages
- **Your current pages:** XX
- **Content gap:** XX pages
- **At [X]/week:** XX weeks to moat

### Feasibility: [GREEN/YELLOW/ORANGE/RED]

[Assessment paragraph — honest, actionable]

### Competitive Advantages
1. [How to build moat faster]
2. [What competitors are missing]

### Timeline
| Phase | Content | Pages | Weeks |
|---|---|---|---|
| Foundation | Hub + core spokes | XX | X |
| Supporting | Long-tail, tutorials | XX | X |
| Authority | Original research, data | XX | X |
| **Total** | | **XX** | **X** |

### Recommendation
[Clear go/no-go with reasoning]
```

## Error Handling

- **Can't find competitors**: Broaden the search. If still no competitors → great sign (blue ocean), estimate moat at 15-20 pages.
- **Niche too broad**: "This niche has too many competitors to analyze meaningfully. Narrow down — run `monopoly-niche-finder` first."
- **User has significant existing content**: Factor in existing pages. May already be at moat → focus on gaps and freshness.
- **All competitors are massive sites**: Recommend niching down. You can't outproduce Forbes — but you can out-specialize them.

## Examples

**Example 1:** "How much content do I need to dominate AI video tools?"
→ Analyze top 5 sites ranking for "best AI video tools". Average 35 pages. Moat = 53 pages. At 2/week = 27 weeks. YELLOW — significant but doable.

**Example 2:** "Can I compete in email marketing?"
→ Analyze competitors. Average 200+ pages. Moat = 300 pages. RED — too broad. Suggest: "email marketing for Shopify stores" (moat = 25 pages, GREEN).

**Example 3:** "Content moat for my keyword clusters" (after keyword-cluster-architect)
→ Use cluster data to estimate pages needed per cluster. Compare against competitors per cluster. Identify which clusters are GREEN vs RED.

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — how many articles and what type to write
- `grand-slam-offer` (S4) — authority gaps inform what to emphasize in offers
- `proprietary-data-generator` (S7) — identifies data moat opportunities

### Fed By

- `keyword-cluster-architect` (S3) — cluster count informs moat estimation
- `seo-audit` (S6) — current content performance data
- `performance-report` (S6) — content performance metrics

### Feedback Loop

- `performance-report` (S6) tracks progress toward moat target → celebrate milestones, adjust strategy if falling behind

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (assessment feels actionable)

Any NO → rewrite before delivering.

## References

- `shared/references/seo-strategy.md` — Topical authority model, moat calculation formula
- `shared/references/case-studies.md` — Real content strategy examples
- `shared/references/flywheel-connections.md` — Master connection map
