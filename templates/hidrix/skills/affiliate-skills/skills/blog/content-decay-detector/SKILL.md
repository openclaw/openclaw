---
name: content-decay-detector
description: >
  Monitor existing content for ranking drops and trigger refresh workflows.
  Triggers on: "check for content decay", "which content needs updating", "content refresh",
  "ranking drops", "traffic decline", "stale content", "content audit", "what to refresh",
  "outdated content", "content performance check", "update old articles",
  "declining rankings", "content maintenance", "refresh priority list",
  "which articles are losing traffic", "SEO content audit".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "content-audit", "decay"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# Content Decay Detector

Monitor existing content for ranking drops and generate a prioritized refresh queue. Refreshing decaying content is the highest-ROI SEO activity — it's faster and cheaper than creating new content, and recovering a lost position is easier than earning a new one.

## Stage

S3: Blog & SEO — Blog maintenance and optimization. This skill keeps your existing content competitive and prevents rankings from silently eroding.

## When to Use

- User has existing blog content and wants to check for decay
- User notices traffic declining on specific pages
- User asks "what content needs updating?"
- User says "content decay", "ranking drops", "stale content", "refresh", "content audit"
- Monthly maintenance check — should run every 30 days on active blogs
- After `seo-audit` reveals declining pages

## Input Schema

```yaml
site_url: string              # REQUIRED — the site to audit
                              # e.g., "myblog.com", "example.com/blog"

content_list: object[]        # OPTIONAL — specific pages to check
  - url: string               # Page URL
    title: string             # Page title
    publish_date: string      # Original publish date
    last_updated: string      # Last update date
    target_keyword: string    # Primary keyword

check_competitors: boolean    # OPTIONAL — whether to check if competitors published fresher content
                              # Default: true

timeframe: string             # OPTIONAL — "30d" | "90d" | "6m" | "1y"
                              # Default: "90d"
```

**Chaining from S6 seo-audit**: Use `declining_pages` as the `content_list`.

## Workflow

### Step 1: Gather Content Data

If `content_list` not provided:

1. `web_search`: `site:[site_url]` — discover indexed pages
2. Identify the top 15-20 most important pages (by topic relevance)
3. For each page, note: title, URL, apparent publish/update date

### Step 2: Check for Decay Signals

Read `shared/references/seo-strategy.md` for decay signals and refresh methodology.

For each page:

1. `web_search` for the page's target keyword — check current ranking position
2. Look for decay signals:
   - **Outdated information**: Product features, pricing, dates mentioned
   - **Competitor freshness**: Newer, better content published by competitors
   - **Missing elements**: No images, no data, thin content compared to current SERP
   - **Broken patterns**: "2023" in a title when it's 2025+, discontinued products mentioned

### Step 3: Score Decay Priority

For each decaying page, assign priority:

| Factor            | Score          | Criteria                                                     |
| ----------------- | -------------- | ------------------------------------------------------------ |
| Revenue impact    | 1-5            | Contains affiliate links + had traffic = high revenue impact |
| Decay severity    | 1-5            | Major outdated info = 5, minor = 1                           |
| Fix effort        | 1-5 (inverted) | Easy fix = 5, full rewrite = 1                               |
| Competitor threat | 1-5            | Competitor published better version = 5                      |

**Priority = Revenue × Decay × Fix_Ease × Competitor_Threat** (normalized)

### Step 4: Generate Refresh Instructions

For each page in priority order, specify:

1. **What's decayed** — specific outdated elements
2. **What to update** — concrete changes to make
3. **What to add** — new sections, data, or elements competitors have
4. **Internal linking** — new pages to link to/from since original publish
5. **Estimated effort** — time to refresh

### Step 5: Self-Validation

- [ ] Decay signals are evidence-based (not guesses)
- [ ] Priority ordering makes business sense (revenue-impacting first)
- [ ] Refresh instructions are specific and actionable
- [ ] Effort estimates are realistic
- [ ] Not recommending refreshes for content that's performing fine

## Output Schema

```yaml
output_schema_version: "1.0.0"
content_decay:
  site: string
  pages_analyzed: number
  pages_decaying: number
  total_refresh_effort: string # Estimated total hours

  decaying_pages:
    - url: string
      title: string
      priority: string # "P0-critical" | "P1-high" | "P2-medium" | "P3-low"
      decay_signals: string[]
      refresh_actions: string[]
      estimated_effort: string
      revenue_impact: string # "high" | "medium" | "low"

  healthy_pages: string[] # Pages that don't need refresh

chain_metadata:
  skill_slug: "content-decay-detector"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "affiliate-blog-builder"
    - "seo-audit"
    - "internal-linking-optimizer"
    - "keyword-cluster-architect"
```

## Output Format

```
## Content Decay Report: [Site]

### Summary
- **Pages analyzed:** XX
- **Pages decaying:** XX
- **Total refresh effort:** XX hours
- **Estimated traffic recovery:** XX%

### Priority Refresh Queue

#### P0 — Critical (do this week)

**[Page Title]** — [URL]
- Decay: [what's wrong]
- Action: [what to do]
- Effort: [time estimate]
- Impact: [expected result]

#### P1 — High (do this month)
[same structure]

#### P2 — Medium (schedule)
[same structure]

### Healthy Pages (no action needed)
- [Page] — still ranking, content fresh
- [Page] — recently updated

### Monthly Maintenance Schedule
- Week 1: Refresh P0 pages
- Week 2: Refresh P1 pages
- Week 3: Create new content for gaps found
- Week 4: Internal linking review
```

## Error Handling

- **No site URL**: "I need your blog URL to check for content decay. What's the site?"
- **Site has no indexed pages**: "I can't find indexed pages for this URL. Check that the site is public and indexed by search engines."
- **All content is fresh**: "Great news — no significant decay detected. Run this check again in 30 days."
- **Can't determine ranking positions**: Use available signals (content age, competitor freshness, outdated info) for prioritization.

## Examples

**Example 1:** "Check my blog for content decay"
→ Discover indexed pages, check each for decay signals, generate prioritized refresh queue with specific actions per page.

**Example 2:** "Which of my articles need updating?"
→ Analyze content list, identify outdated pricing, stale comparisons, missing new products. Rank by revenue impact.

**Example 3:** "Content decay check" (after seo-audit)
→ Pick up declining pages from seo-audit output. Deep-dive each with competitor analysis and specific refresh instructions.

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — refresh instructions for specific articles
- `internal-linking-optimizer` (S6) — decaying pages may need better internal links
- `keyword-cluster-architect` (S3) — content gaps revealed by decay analysis

### Fed By

- `seo-audit` (S6) — declining pages to investigate
- `internal-linking-optimizer` (S6) — pages with weak link structure may be decaying
- `performance-report` (S6) — traffic decline data

### Feedback Loop

- After refreshing, `seo-audit` (S6) tracks whether rankings recovered → measure refresh ROI, refine decay detection sensitivity

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (refresh actions feel actionable)

Any NO → rewrite before delivering.

## References

- `shared/references/seo-strategy.md` — Decay signals, refresh methodology, priority matrix
- `shared/references/flywheel-connections.md` — Master connection map
