---
name: niche-opportunity-finder
description: >
  Find untapped affiliate niches with real earning potential.
  Use this skill when the user asks about picking a niche, finding a niche to start
  affiliate marketing, what niche to get into, niche research, niche ideas,
  beginner niche selection, low competition niches, profitable niches, or says
  "I don't know what to promote", "help me pick a niche", "what niche should I
  start with", "find me a niche with less competition", "niche ideas for affiliate",
  "is X a good niche for affiliate marketing", "best niches 2024", "untapped niches".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "research", "niche-analysis", "program-discovery", "niche", "opportunity"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Niche Opportunity Finder

Analyze search demand, competition, and available affiliate programs to surface
untapped niches worth entering. Outputs a scored shortlist with clear reasoning
so beginners can start promoting in under an hour.

## Stage

This skill belongs to Stage S1: Research

## When to Use

- User is new to affiliate marketing and has no niche
- User is unhappy with their current niche and wants alternatives
- User wants to validate a niche idea before investing time
- User asks which niches are trending or low-competition
- User wants to find niches underserved by existing affiliates

## Input Schema

```
{
  interests: string[]       # (optional) Topics user already knows or cares about
  audience: string          # (optional) Who they plan to reach — "beginners", "professionals", "parents"
  platform: string          # (optional) Where they'll publish — "blog", "tiktok", "youtube", "linkedin"
  budget: string            # (optional) "zero" | "low ($0-50/mo)" | "medium ($50-200/mo)"
  goal: string              # (optional) "first $100" | "side income $1k/mo" | "full-time income"
  avoid: string[]           # (optional) Niches or topics to exclude
}
```

## Workflow

### Step 1: Understand the User's Situation

Ask (if not already clear from context):

1. Any topics you already know well or are curious about?
2. Where will you publish content? (blog, TikTok, YouTube, newsletter...)
3. What's your income goal in the first 6 months?

If user says "just find me something" → default to: AI/SaaS tools, YouTube or blog,
goal = first $500/mo.

### Step 2: Generate Niche Candidates

Produce 8-12 niche candidates across 3 tiers:

**Tier A — Trending (high demand, growing fast):**
Use `web_search "fastest growing affiliate niches [current year]"` and
`web_search "trending affiliate programs [current year]"` to find niches with
momentum. Look for: AI tools, health tech, fintech, remote work tools, creator economy.

**Tier B — Evergreen (stable demand, proven programs):**
Always-on niches: personal finance, web hosting, email marketing, SEO tools,
fitness/wellness, online education, cybersecurity.

**Tier C — Micro-niches (narrow, low competition, high intent):**
Examples: AI tools for lawyers, budgeting apps for freelancers, SEO for Shopify
stores, productivity tools for ADHD. These are combinations of a vertical + a job
or persona. Use `web_search "[vertical] affiliate programs [persona]"` to discover.

### Step 3: Score Each Niche

Score each candidate on 4 dimensions (1-10 scale each):

| Dimension            | Weight | How to Assess                                                                                                                                    |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search Demand        | 30%    | `web_search "[niche] how to" — look at result count and autosuggest depth                                                                        |
| Program Availability | 30%    | Search list.affitor.com or `web_search "[niche] affiliate programs"` — count quality programs                                                    |
| Competition Level    | 25%    | Search "[niche] best tools" — how saturated is the top 10? Fewer exact-match affiliate sites = less competition. Score 10 = very low competition |
| Content Potential    | 15%    | Can tutorials, comparisons, listicles, and reviews be made for this niche easily?                                                                |

**Overall score** = weighted average. Cut anything below 5.5.

Verdict: 7.5+ = "High Opportunity" / 5.5-7.4 = "Worth Testing" / <5.5 = "Saturated/Skip"

### Step 4: Validate Top 3 Niches on list.affitor.com

For the top 3 niches, check `list.affitor.com` (see `references/list-affitor-api.md`)
to verify real programs exist with good commission structures:

- At least 3 programs with `reward_value` 20%+ OR `reward_type` cps_recurring
- At least one program with `cookie_days` >= 30
- Programs with `stars_count` > 5 (community-validated quality)

If a niche scores well on demand but has no programs on list.affitor.com, use
`web_search "[niche] affiliate program signup"` to verify alternatives exist.

### Step 5: Build the Opportunity Brief

For the top-ranked niche, produce a one-page opportunity brief (see Output Format).
For runner-up niches, produce summary cards only.

### Step 6: Recommend Next Steps

Map user's chosen niche to the affiliate funnel:

1. Use `affiliate-program-search` to find the best specific program in this niche
2. Use `tiktok-script-writer` or `twitter-thread-writer` for first content
3. Use `commission-calculator` to project first 90 days of income

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] Search demand backed by data (autosuggest depth, result count)
- [ ] Top niche has ≥3 programs with 20%+ commission on list.affitor.com
- [ ] Competition score reflects actual top-10 SERP analysis
- [ ] Content angles are specific and actionable, not generic

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  top_niche: {
    name: string              # "AI Productivity Tools"
    tier: string              # "Trending" | "Evergreen" | "Micro-niche"
    score: number             # 8.4
    verdict: string           # "High Opportunity"
    why: string               # 2-3 sentence rationale
    example_programs: string[] # ["Notion", "ClickUp", "Reclaim AI"]
    content_angles: string[]  # ["comparison", "workflow walkthrough", "beginner guide"]
    difficulty: string        # "Beginner-friendly" | "Intermediate" | "Advanced"
  }
  runner_up: NicheCandidate   # Same structure
  all_scored: NicheScore[]    # Full list with scores
  recommended_next_skill: string  # "affiliate-program-search"
}
```

## Output Format

```
## Niche Opportunity Report

### Top Pick: [Niche Name]

**Opportunity Score:** [X.X/10] — [Verdict]
**Tier:** [Trending / Evergreen / Micro-niche]
**Difficulty:** [Beginner-friendly / Intermediate / Advanced]

**Why this niche:**
[2-3 sentences covering demand, program quality, and why it's not yet saturated]

| Dimension | Score | Evidence |
|-----------|-------|----------|
| Search Demand | X/10 | [What search data showed] |
| Program Availability | X/10 | [X programs found, avg commission Y%] |
| Competition Level | X/10 | [What competitor landscape looks like] |
| Content Potential | X/10 | [Content formats that work here] |
| **Overall** | **X.X/10** | **[Verdict]** |

**Example affiliate programs:** [Program A], [Program B], [Program C]

**Content angles to start with:**
1. [Angle 1 — specific post/video idea]
2. [Angle 2]
3. [Angle 3]

---

### Runner-up: [Niche Name] — [X.X/10]
[2-sentence summary + why it's #2]

### Other Candidates Scored

| Niche | Score | Verdict | Note |
|-------|-------|---------|------|
| ...   | ...   | ...     | ...  |

---

## Next Steps

1. Run `affiliate-program-search` to find the best [Niche] program on list.affitor.com
2. Run `commission-calculator` to project 90-day earnings
3. Run `tiktok-script-writer` or `twitter-thread-writer` to create your first piece of content
```

## Error Handling

- **No interests provided:** Default to AI/SaaS tools niche. Explain the default.
- **Niche too broad (e.g., "health"):** Break into sub-niches and score each separately. Present as micro-niche grid.
- **Niche too narrow (e.g., "left-handed guitarists who use Linux"):** Widen one dimension and present a spectrum of options.
- **No programs found for top niche:** Still present the niche but flag program gap. Suggest direct brand deals as alternative.
- **User picks a saturated niche:** Don't just say no. Find the micro-niche angle within it that is less saturated.
- **Conflicting interests:** Ask user to pick one dimension (monetization speed vs. passion vs. content ease) and sort by that.

## Examples

**Example 1:**
User: "I want to start affiliate marketing but have no idea what niche to pick"
→ Ask: any interests? what platform? income goal?
→ If no answer: default to AI/SaaS tools on YouTube/TikTok, goal = first $500/mo
→ Generate 10 candidates, score all, return top 3 with detailed brief for #1

**Example 2:**
User: "Is fitness a good niche for affiliate marketing?"
→ Validate fitness niche: high demand, many programs (MyProtein, Noom, Whoop)
→ Flag: highly competitive on Google. Score = 6.2 "Worth Testing"
→ Suggest micro-niches: fitness for new moms, home gym under $500, wearables for runners
→ Score micro-niches — surface the strongest one

**Example 3:**
User: "I know a lot about Notion and productivity tools"
→ Lean into existing knowledge: AI productivity tools, note-taking apps, PKM space
→ Score with "expert authority" bonus — existing knowledge = faster content creation
→ Surface programs: Notion, Obsidian affiliate, ClickUp, Reclaim AI
→ Recommend micro-niche: "AI tools for knowledge workers" — score 8.1

## References

- `references/list-affitor-api.md` — how to fetch programs from list.affitor.com
- `shared/references/affiliate-glossary.md` — affiliate marketing terminology
- `shared/references/ftc-compliance.md` — disclosure requirements
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `affiliate-program-search` (S1) — validated niches to search programs in
- `monopoly-niche-finder` (S1) — niche data for intersection analysis
- `keyword-cluster-architect` (S3) — niche defines keyword universe
- `content-moat-calculator` (S3) — niche for feasibility analysis

### Fed By

- `performance-report` (S6) — performance data identifies best-performing niches
- `conversion-tracker` (S6) — conversion data reveals profitable niches

### Feedback Loop

- Performance data from S6 shows which niche characteristics predict success → refine opportunity scoring

```yaml
chain_metadata:
  skill_slug: "niche-opportunity-finder"
  stage: "research"
  timestamp: string
  suggested_next:
    - "affiliate-program-search"
    - "monopoly-niche-finder"
    - "keyword-cluster-architect"
```
