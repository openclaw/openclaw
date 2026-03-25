---
name: keyword-cluster-architect
description: >
  Map 50-200+ keywords into topical clusters for SEO domination. Build content roadmaps
  for topical authority.
  Triggers on: "keyword research", "keyword clustering", "topical authority", "keyword map",
  "keyword strategy", "content roadmap for SEO", "keyword grouping", "topic clusters",
  "SEO keyword plan", "map my keywords", "keyword cluster", "hub and spoke content",
  "build topical authority", "SEO content plan", "keyword universe".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "keywords", "clustering"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# Keyword Cluster Architect

Map 50-200+ keywords into topical clusters grouped by search intent. Build a content roadmap for dominating a topic with hub-and-spoke architecture. Google rewards topical authority — this skill builds the strategic map that tells you exactly what content to create and in what order.

## Stage

S3: Blog & SEO — This is the strategic planning layer FOR blog content. Before writing individual posts, you need a map of the entire keyword landscape organized into clusters.

## When to Use

- User wants to plan SEO content strategy for a niche
- User asks about keyword research, clustering, or topical authority
- User says "keyword", "SEO plan", "content roadmap", "topic cluster", "hub and spoke"
- Before running `affiliate-blog-builder` — to know WHICH articles to write
- After `monopoly-niche-finder` — to map the keyword universe for the winning niche

## Input Schema

```yaml
niche:
  string # REQUIRED — the topic to cluster
  # e.g., "AI video tools", "email marketing for SaaS"

seed_keywords:
  string[] # OPTIONAL — starting keywords to expand from
  # Default: auto-generated from niche

depth:
  string # OPTIONAL — "quick" (50 keywords) | "standard" (100) | "deep" (200+)
  # Default: "standard"

affiliate_products:
  string[] # OPTIONAL — products you promote (to prioritize commercial keywords)
  # Default: none
```

**Chaining from S1 monopoly-niche-finder**: Use `monopoly_niche.intersection` as the `niche` input.

## Workflow

### Step 1: Generate Seed Keywords

If not provided, generate 5-10 seed keywords from the niche:

- Product-focused: "[product] review", "best [category]"
- Problem-focused: "how to [solve problem]", "[problem] solution"
- Comparison: "[product A] vs [product B]", "alternatives to [product]"
- Tutorial: "how to use [product]", "[product] tutorial"

### Step 2: Expand Keywords

For each seed, use `web_search` to discover related keywords:

1. Search: `"[seed keyword]"` — note related searches, People Also Ask
2. Search: `"[seed keyword] guide" OR "[seed keyword] tutorial"` — informational variants
3. Search: `"best [seed keyword]" OR "[seed keyword] review"` — commercial variants

Collect 50-200+ unique keywords depending on `depth`.

### Step 3: Classify by Intent

Read `shared/references/seo-strategy.md` for clustering methodology.

Classify each keyword:

- **Informational** (I): Learning, how-to, what-is → blog posts, tutorials
- **Commercial** (C): Comparing, evaluating, reviewing → comparison posts, reviews
- **Transactional** (T): Ready to buy, pricing, discount → landing pages, deal pages
- **Navigational** (N): Brand-specific, login → skip (not your traffic to capture)

### Step 4: Cluster by Topic

Group keywords that share the same search intent (would be answered by the same page):

```
Cluster: "[Main Topic]"
  Type: [I/C/T]
  Hub keyword: [highest volume keyword]
  Supporting keywords:
    - [keyword 1] — [est. volume]
    - [keyword 2] — [est. volume]
  Content type: [blog post / comparison / review / tutorial / landing page]
  Priority: [1-5 based on volume × intent × competition]
```

### Step 5: Build Content Roadmap

Organize clusters into a hub-and-spoke map:

1. Identify the hub page (broadest, highest-volume cluster)
2. Connect spoke pages (specific clusters that link back to hub)
3. Prioritize by: commercial intent first (revenue), then informational (traffic)
4. Estimate effort: number of articles needed, suggested publishing cadence

### Step 6: Self-Validation

- [ ] Clusters are based on actual search data, not guesses
- [ ] Each cluster has a clear search intent (I, C, or T)
- [ ] Hub-and-spoke structure is logical (hub is broad, spokes are specific)
- [ ] Priority ordering makes business sense (revenue-driving content first)
- [ ] Total content pieces are realistic for user's capacity

## Output Schema

```yaml
output_schema_version: "1.0.0"
keyword_clusters:
  niche: string
  total_keywords: number
  total_clusters: number

  hub:
    keyword: string
    cluster_name: string
    content_type: string
    priority: number

  clusters:
    - name: string
      intent: string # "informational" | "commercial" | "transactional"
      hub_keyword: string
      keywords: string[]
      content_type: string # "blog" | "comparison" | "review" | "tutorial" | "landing"
      priority: number # 1-5
      estimated_volume: string

  content_roadmap:
    total_articles: number
    publishing_cadence: string
    priority_order: string[] # Cluster names in order to write

  target_keywords: string[] # Flat list of all keywords for chaining

chain_metadata:
  skill_slug: "keyword-cluster-architect"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "affiliate-blog-builder"
    - "content-moat-calculator"
    - "comparison-post-writer"
    - "landing-page-creator"
```

## Output Format

```
## Keyword Cluster Map: [Niche]

### Overview
- **Total keywords:** XXX
- **Clusters:** XX
- **Hub topic:** [main hub]
- **Content pieces needed:** XX articles

### Hub & Spoke Map
```

           [HUB: Main Topic]
          /    |    |    \
     [Spoke] [Spoke] [Spoke] [Spoke]
       |       |       |       |
     [Sub]   [Sub]   [Sub]   [Sub]

```

### Clusters by Priority

#### Priority 1: [Cluster Name] (Commercial Intent)
- **Hub keyword:** [keyword] — [volume]
- **Content type:** [comparison / review]
- **Keywords:** [list]
- **Article idea:** [specific title]

#### Priority 2: [Cluster Name] (Informational Intent)
[same structure]

[Continue for all clusters]

### Content Roadmap
| Week | Cluster | Article | Intent | Priority |
|---|---|---|---|---|
| 1 | [cluster] | [title] | C | 1 |
| 2 | [cluster] | [title] | C | 1 |
| 3 | [cluster] | [title] | I | 2 |

### Next Steps
- Run `content-moat-calculator` to estimate effort for topical authority
- Run `affiliate-blog-builder` for Priority 1 articles
- Run `comparison-post-writer` for commercial clusters
```

## Error Handling

- **Niche too broad**: "This niche is very broad. Let me narrow to a sub-niche for more actionable clusters. Or run `monopoly-niche-finder` first."
- **No search volume**: "This niche may be too narrow for significant search traffic. Consider broadening slightly."
- **Too many keywords**: Group aggressively into fewer clusters. Quality of clustering > quantity of keywords.
- **No commercial intent keywords**: Flag as concern — hard to monetize through affiliate without commercial intent. Suggest adjacent niches.

## Examples

**Example 1:** "Map keywords for AI video tools"
→ Seeds: "best AI video tools", "AI video generator", "HeyGen review". Expand to 100+ keywords. Cluster: "AI video reviews" (C), "how to make AI videos" (I), "AI video pricing" (T), "AI video vs traditional" (C). Hub: "Best AI Video Tools 2025".

**Example 2:** "Keyword strategy for my affiliate blog about email marketing"
→ Deep keyword research. Clusters: "email marketing platforms" (C), "email automation tutorials" (I), "email marketing pricing comparison" (T), "email deliverability guides" (I).

**Example 3:** "Plan my content roadmap" (after monopoly-niche-finder)
→ Pick up niche from chain. Map 100+ keywords in that intersection niche. Prioritize clusters by revenue potential.

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — which articles to write and target keywords
- `comparison-post-writer` (S3) — commercial clusters become comparison articles
- `content-moat-calculator` (S3) — keyword count informs moat estimation
- `landing-page-creator` (S4) — transactional clusters become landing pages
- `internal-linking-optimizer` (S6) — cluster structure defines link architecture

### Fed By

- `monopoly-niche-finder` (S1) — niche to cluster keywords for
- `content-pillar-atomizer` (S2) — content pillars suggest keyword areas
- `seo-audit` (S6) — current ranking data reveals keyword gaps

### Feedback Loop

- `seo-audit` (S6) reveals ranking gaps in existing clusters → add keywords and new content to fill gaps

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (roadmap feels actionable)

Any NO → rewrite before delivering.

## References

- `shared/references/seo-strategy.md` — Topical authority, clustering methodology, hub-and-spoke
- `shared/references/affiliate-glossary.md` — Terminology
- `shared/references/flywheel-connections.md` — Master connection map
