---
name: monopoly-niche-finder
description: >
  Find intersection niches where you're the ONLY voice. Thiel's "competition is for losers" lens.
  Triggers on: "find my monopoly niche", "blue ocean niche", "unique niche", "niche intersection",
  "where am I the only one", "zero competition niche", "untapped niche", "category of one",
  "Thiel monopoly", "dominate a niche", "niche nobody else covers", "cross two domains",
  "find a niche with no competition", "monopoly positioning", "unique angle for affiliate".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "research",
    "niche-analysis",
    "program-discovery",
    "monopoly",
    "blue-ocean",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Monopoly Niche Finder

Find intersection niches where you're the ONLY voice. Based on Peter Thiel's "competition is for losers" — instead of fighting for market share in "AI tools" or "SaaS reviews," cross two domains to create a niche where you're the default authority. Example: "AI video tools for real estate agents" — specific enough to own, broad enough to monetize.

## Stage

S1: Research — Finding your monopoly niche IS research. This happens before you pick a program, before you write content. It's the strategic foundation that makes everything downstream easier.

## When to Use

- User is starting out and hasn't picked a niche yet
- User is in a crowded niche and struggling with competition
- User wants a unique angle for affiliate marketing
- User says "monopoly", "blue ocean", "unique niche", "no competition"
- User has expertise in two domains and wants to combine them
- Before running `affiliate-program-search` to narrow the search space

## Input Schema

```yaml
domain_1:
  string # OPTIONAL — first area of expertise/interest
  # e.g., "real estate", "fitness", "accounting"
  # Default: ask user

domain_2:
  string # OPTIONAL — second area to cross with
  # e.g., "AI tools", "no-code", "automation"
  # Default: suggest options

existing_audience:
  string # OPTIONAL — who already follows/reads you
  # e.g., "small business owners", "developers"
  # Default: none

monetization_goal:
  string # OPTIONAL — "affiliate" | "info-product" | "both"
  # Default: "affiliate"
```

## Workflow

### Step 1: Identify Domains

If domains not provided:

1. Ask user about their expertise, work experience, hobbies
2. Ask about their audience (if any)
3. Suggest 3-5 domain pairs based on their profile

If one domain provided, suggest 3-5 complementary domains to cross with.

### Step 2: Generate Intersection Niches

For each domain pair, generate 3-5 intersection niches:

Format: `[Domain 1] × [Domain 2] = [Intersection Niche]`

For each intersection:

1. **Specificity test**: Is this specific enough that you could be the #1 resource?
2. **Size test**: Is the audience large enough to monetize? (at least 10K potential monthly searches)
3. **Passion test**: Could you create 50+ pieces of content about this without burning out?
4. **Monetization test**: Are there affiliate programs in this space?

### Step 3: Validate with Data

For each top intersection niche:

1. `web_search` for `"[intersection niche]" site:reddit.com` — are people asking about this?
2. `web_search` for `"[intersection niche]" blog` — how many dedicated resources exist? (fewer = better)
3. `web_search` for `"[intersection niche]" affiliate program` — monetization potential
4. Check competitor landscape: if top 10 results are big brands → narrow further. If thin content → opportunity.

### Step 4: Score and Rank

Score each niche on:
| Factor | Weight | Scoring |
|---|---|---|
| Monopoly potential | 30% | 1-10: how few competitors |
| Monetization | 25% | 1-10: affiliate program quality |
| Audience size | 20% | 1-10: search volume + community size |
| Your fit | 15% | 1-10: expertise + passion |
| Content potential | 10% | 1-10: can you create 50+ pieces |

### Step 5: Deep Dive Top Niche

For the #1 scored niche:

1. Map 10-15 content topics you could cover
2. Identify 3-5 affiliate programs that fit
3. Describe the "ideal reader" persona
4. Suggest the first 3 pieces of content to create

### Step 6: Self-Validation

- [ ] Top niche has genuinely low competition (verified by search)
- [ ] Affiliate programs exist for this niche
- [ ] Content topics are specific (not generic)
- [ ] Niche is narrow enough to dominate but wide enough to sustain

## Output Schema

```yaml
output_schema_version: "1.0.0"
monopoly_niche:
  domain_1: string
  domain_2: string
  intersection: string # The winning niche
  monopoly_score: number # 1-100 composite
  competition_level: string # "none" | "minimal" | "moderate" | "high"
  audience_size: string # Estimated monthly search interest
  affiliate_programs: string[] # Programs that fit this niche

niche_candidates: # All evaluated niches
  - intersection: string
    score: number
    competition: string
    monetization: string

content_roadmap:
  ideal_reader: string
  first_topics: string[] # First 3 content pieces
  total_topics: number # How many topics mapped

chain_metadata:
  skill_slug: "monopoly-niche-finder"
  stage: "research"
  timestamp: string
  suggested_next:
    - "affiliate-program-search"
    - "niche-opportunity-finder"
    - "keyword-cluster-architect"
    - "category-designer"
```

## Output Format

```
## Monopoly Niche Analysis

### Your Domains
- Domain 1: [domain]
- Domain 2: [domain]

### Intersection Niches Evaluated

| # | Intersection | Monopoly | Monetization | Audience | Fit | Content | Score |
|---|---|---|---|---|---|---|---|
| 1 | [niche] | X/10 | X/10 | X/10 | X/10 | X/10 | XX/100 |
| 2 | ... | | | | | | |

### Winner: [Top Niche]

**Why this is a monopoly niche:**
[Explanation — why you can be the ONLY voice here]

**Competition check:**
[What exists today — and why it's not enough]

**Affiliate programs:**
[3-5 programs that fit, with commission data]

**Your ideal reader:**
[Persona description]

### Content Roadmap (first 3 pieces)
1. [Topic] — [why this first]
2. [Topic] — [builds on #1]
3. [Topic] — [establishes authority]

### Next Steps
- Run `affiliate-program-search` filtered to [niche] programs
- Run `keyword-cluster-architect` to map the full content opportunity
- Run `category-designer` to name and own your category
```

## Error Handling

- **No domains provided**: "Tell me about your expertise, work, or interests — I'll help you find where two worlds collide into a monopoly niche."
- **Domains too similar**: "These are in the same space. Try crossing with something unexpected — the magic is in unlikely combinations."
- **No affiliate programs found**: Expand the niche slightly or suggest adjacent programs. "The niche is great for content, but let's find adjacent programs you can promote."
- **Niche too narrow**: "This might be too specific to sustain content. Let me widen the lens slightly..."

## Examples

**Example 1:** "I know real estate and I'm into AI tools"
→ Intersections: "AI tools for real estate agents", "AI property photography", "AI-powered real estate marketing", "Automated real estate content creation", "AI virtual staging tools". Validate each, score, deep-dive the winner.

**Example 2:** "I'm a developer struggling to stand out in the SaaS review space"
→ Cross "developer" with "SaaS": "Developer tools for non-technical founders", "DevOps tools for solo SaaS builders", "API-first marketing tools". Find the gap where dev expertise adds credibility.

**Example 3:** "Find me a niche with no competition"
→ Ask about domains/interests first, then generate intersections, validate with search data, prove low competition with evidence.

## Flywheel Connections

### Feeds Into

- `affiliate-program-search` (S1) — narrowed niche for program discovery
- `niche-opportunity-finder` (S1) — validated niche to explore further
- `keyword-cluster-architect` (S3) — niche defines keyword universe
- `content-pillar-atomizer` (S2) — niche positioning for content angles
- `category-designer` (S8) — niche to formalize into a category

### Fed By

- `seo-audit` (S6) — ranking data reveals niches you're already winning in
- `performance-report` (S6) — performance data shows which niche content converts

### Feedback Loop

- `conversion-tracker` (S6) shows which niche topics convert best → double down on highest-converting intersection angles

## References

- `shared/references/affiliate-glossary.md` — Terminology
- `shared/references/case-studies.md` — Real niche success stories
- `shared/references/flywheel-connections.md` — Master connection map
