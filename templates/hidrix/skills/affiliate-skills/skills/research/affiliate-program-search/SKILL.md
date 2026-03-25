---
name: affiliate-program-search
description: >
  Research and evaluate affiliate programs to find the best ones to promote.
  Use this skill when the user asks anything about finding affiliate programs,
  comparing commission rates, evaluating affiliate opportunities, searching for
  products to promote, picking a niche, or mentions list.affitor.com.
  Also trigger for: "which SaaS should I promote", "best affiliate programs for X",
  "high commission programs", "recurring commission affiliate", "compare these
  affiliate programs", "is X affiliate program worth it", "find me something to promote",
  "what pays the most", "affiliate programs with long cookie duration".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "research", "niche-analysis", "program-discovery", "saas", "commission"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Affiliate Program Search

Help affiliate marketers research, evaluate, and pick winning programs to promote.
Data source: [list.affitor.com](https://list.affitor.com) — Affitor's community-driven affiliate program directory.

## Stage

This skill belongs to Stage S1: Research

## When to Use

- User wants to find affiliate programs to promote
- User wants to compare two or more affiliate programs
- User asks about commission rates, cookie duration, or earning potential
- User mentions list.affitor.com
- User is new to affiliate marketing and needs a starting point

## Input Schema

```
{
  niche: string             # (optional, default: "AI/SaaS tools") Category or niche interest
  commission_pref: string   # (optional, default: "recurring, 20%+") Commission preference
  audience: string          # (optional, default: "content creators") Target audience type
  platform: string          # (optional, default: "any") Platform they'll promote on
  compare: string[]         # (optional) Specific programs to compare head-to-head
}
```

## Workflow

### Step 1: Understand What the User Wants

Ask (if not clear from context):

- Niche/category interest? (AI tools, SEO, video, writing, automation...)
- Commission preference? (recurring vs one-time, minimum %)
- Audience type? (developers, marketers, beginners, enterprise...)
- Platform they'll promote on? (blog, LinkedIn, YouTube, X...)

If user says "just find me something good" → default to: AI/SaaS tools, recurring commission, 20%+, content creator audience.

### Step 2: Search list.affitor.com

See `references/list-affitor-api.md` for integration methods.

Two methods available:

- **API (preferred):** `GET /api/v1/programs` with API key auth — structured data, filterable
- **Web fetch (fallback):** `web_search "site:list.affitor.com [category]"` then `web_fetch` the page

Extract for each program: `name`, `reward_value`, `reward_type`, `cookie_days`, `stars_count`, `tags`, `description`.

### Step 3: Score Programs

Apply the scoring framework from `references/scoring-criteria.md`.

Score each program on 5 dimensions (1-10 scale):

1. **Earning Potential** (30%) — commission %, recurring vs one-time, product price
2. **Content Potential** (25%) — visual demo, free tier, content angles
3. **Market Demand** (20%) — search volume, trend direction, market size
4. **Competition Level** (15%) — fewer affiliates promoting = higher score
5. **Trust Factor** (10%) — product quality, reputation, stars on list.affitor.com

Overall = weighted average. Verdict: 7.5+ "Strong Pick" / 5.5-7.4 "Worth Testing" / <5.5 "Skip".

For dimensions that require external data (Market Demand, Competition Level), use `web_search` to check Google results count for "[product] review" and "[product] affiliate" queries.

### Step 4: Present Recommendation

### Step 5: Self-Validation

Before presenting output, verify:

- [ ] All scored programs have `reward_value` from API data, not hallucinated
- [ ] `cookie_days` is numeric and from API response
- [ ] Top Pick verdict matches score threshold (≥7.5 = Strong Pick, ≥6 = Worth Considering)
- [ ] Market Demand and Competition scores cite the search query used
- [ ] Stale data (>6 months) is flagged with warning

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

Other skills (viral-post-writer, affiliate-blog-builder, etc.) consume these fields from conversation context:

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  recommended_program: {
    name: string              # "HeyGen"
    slug: string              # "heygen"
    reward_value: string      # "30%"
    reward_type: string       # "cps_recurring"
    reward_duration: string   # "12 months"
    cookie_days: number       # 60
    description: string       # Short product description
    tags: string[]            # ["ai", "video"]
    url: string               # Product website
  }
  score: {
    overall: number           # 8.2
    verdict: string           # "Strong Pick"
    reasoning: string         # Why this is the top pick
  }
  runner_up: Program | null   # Same structure, second choice
  all_scored: ProgramScore[]  # Full list of scored programs
}
```

## Output Format

```
## Programs Found

| Program | Commission | Type | Cookie | Stars | Score |
|---------|-----------|------|--------|-------|-------|
| HeyGen  | 30%       | Recurring | 60d | ⭐ 42 | 8.2/10 |
| ...     | ...       | ...  | ...    | ...   | .../10 |

## Top Pick: [Program Name]

**Why:** [2-3 sentences explaining why this is the best fit]

| Dimension | Score | Note |
|-----------|-------|------|
| Earning Potential | 8/10 | 30% recurring on $24-48/mo |
| Content Potential | 9/10 | Visual AI video, easy to demo |
| Market Demand | 8/10 | AI video trending, high search volume |
| Competition | 6/10 | Growing number of affiliates |
| Trust Factor | 8/10 | Strong brand, 42 stars on list.affitor.com |
| **Overall** | **8.2/10** | **Strong Pick** |

## Runner-up: [Program Name]

**Why:** [1-2 sentences]

## Next Steps

1. Sign up for [Program] affiliate program → [search for signup page]
2. Run `viral-post-writer` to create content for this product
3. Run `affiliate-blog-builder` to write a review post
```

## Error Handling

- **API unavailable:** Fall back to web_fetch method (see `references/list-affitor-api.md` Method 2)
- **No programs match criteria:** Broaden search (remove strictest filter first), explain to user what was relaxed
- **Stale data (program updated_at > 6 months):** Flag with "Data may be outdated, verify on product website"
- **User gives no criteria:** Use defaults (AI/SaaS, recurring, 20%+, content creator audience)
- **Program not on list.affitor.com:** Use `web_search` to find program details directly, still apply scoring framework

## Examples

**Example 1:**
User: "I want to promote AI video tools, commission recurring, at least 20%"
→ Search list.affitor.com for programs tagged "ai" or "video"
→ Filter: reward_type = cps_recurring, reward_value ≥ 20%
→ Score and rank: HeyGen, Synthesia, ElevenLabs, InVideo AI...
→ Recommend top pick with full scorecard

**Example 2:**
User: "Compare HeyGen vs Synthesia for my LinkedIn audience"
→ Fetch both from list.affitor.com
→ Score both, emphasize Content Potential for LinkedIn
→ Side-by-side comparison table + recommendation
→ Note: LinkedIn audience = B2B, weight higher-price products

**Example 3:**
User: "I'm a beginner, what should I promote first?"
→ Default criteria: AI/SaaS, recurring, easy-to-demo products
→ Weight beginner-friendly factors: free tier, low payout threshold, strong brand
→ Recommend program with easiest path to first commission

## References

- `references/scoring-criteria.md` — the 5-dimension scoring framework with rubrics
- `references/list-affitor-api.md` — how to fetch data from list.affitor.com (API + fallback)
- `references/platform-rules.md` — platform-specific considerations when recommending programs
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `viral-post-writer` (S2) — `recommended_program` product data for social content
- `twitter-thread-writer` (S2) — `recommended_program` for Twitter threads
- `reddit-post-writer` (S2) — `recommended_program` for Reddit posts
- `content-pillar-atomizer` (S2) — `recommended_program` for content creation
- `affiliate-blog-builder` (S3) — `recommended_program` for blog articles
- `landing-page-creator` (S4) — `recommended_program` for landing pages
- `grand-slam-offer` (S4) — `recommended_program` for offer design
- `bonus-stack-builder` (S4) — product data for bonus design

### Fed By

- `conversion-tracker` (S6) — top converting niches → search for more programs in winning niches
- `performance-report` (S6) — performance data showing which program types convert best

### Feedback Loop

- Conversion data from S6 reveals which program characteristics (commission type, cookie length, niche) correlate with highest earnings → refine search criteria on next run

```yaml
chain_metadata:
  skill_slug: "affiliate-program-search"
  stage: "research"
  timestamp: string
  suggested_next:
    - "purple-cow-audit"
    - "viral-post-writer"
    - "landing-page-creator"
    - "grand-slam-offer"
```
