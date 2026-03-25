---
name: internal-linking-optimizer
description: >
  Analyze site's internal link structure and optimize for hub-and-spoke SEO architecture.
  Triggers on: "optimize internal links", "internal linking", "link structure",
  "hub and spoke links", "orphan pages", "link equity", "internal link audit",
  "fix my internal links", "link architecture", "site structure optimization",
  "internal linking strategy", "link flow", "improve site structure",
  "find orphan pages", "maximize link equity", "internal link map".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "analytics",
    "optimization",
    "tracking",
    "internal-links",
    "site-structure",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S6-Analytics
---

# Internal Linking Optimizer

Analyze your site's internal link structure and generate an optimized hub-and-spoke linking plan. Finds orphan pages (no internal links pointing to them), identifies link equity bottlenecks, and creates specific linking instructions to maximize SEO impact.

## Stage

S6: Analytics & Optimization — This is analytics/audit work on existing content. Internal linking is the most underutilized SEO lever — it's 100% in your control and costs nothing.

## When to Use

- User wants to improve their site's SEO through better internal linking
- User asks about "orphan pages", "link structure", "hub and spoke"
- User says "internal linking", "link audit", "link equity"
- After publishing new content — new pages need internal links within 48 hours
- After `keyword-cluster-architect` — cluster structure defines the ideal link architecture
- Monthly maintenance task alongside `content-decay-detector`

## Input Schema

```yaml
site_url: string              # REQUIRED — site to analyze
                              # e.g., "myblog.com"

pages: object[]               # OPTIONAL — known pages with their topics
  - url: string
    title: string
    topic_cluster: string     # Which topical cluster it belongs to
    is_hub: boolean           # Is this a hub page?

hub_pages: string[]           # OPTIONAL — URLs of your hub/pillar pages
                              # Default: auto-detected

new_pages: string[]           # OPTIONAL — recently published pages needing links
                              # Default: none
```

**Chaining from S3 keyword-cluster-architect**: Use `keyword_clusters.hub` and `keyword_clusters.clusters` to define ideal link architecture.

## Workflow

### Step 1: Discover Site Structure

1. `web_search`: `site:[site_url]` — discover indexed pages
2. Map pages to topic clusters (if not provided)
3. Identify current hub pages (pages that link to many others)
4. Note orphan pages (pages with few/no internal links pointing to them)

### Step 2: Analyze Current Link Structure

Read `shared/references/seo-strategy.md` for internal linking rules.

For each page group:

- Count internal links TO this page (inlinks)
- Count internal links FROM this page (outlinks)
- Check link depth from homepage (should be ≤ 3 clicks)
- Identify the anchor text used

### Step 3: Identify Issues

Flag:

1. **Orphan pages** — no or few internal links pointing to them
2. **Hub pages with weak linking** — hub should link to ALL spokes in its cluster
3. **Missing spoke-to-spoke links** — related spokes should link to each other
4. **Broken contextual flow** — pages that should link to each other but don't
5. **Over-linked pages** — too many outlinks dilute link equity
6. **Missing reverse links** — spoke links to hub but hub doesn't link back

### Step 4: Generate Linking Instructions

For each issue, provide specific instructions:

```
Page: [URL]
Action: Add internal link to [target URL]
Anchor text: "[suggested anchor]"
Location: [where in the content to add it]
Priority: [P0/P1/P2]
Reason: [why this link matters]
```

### Step 5: Self-Validation

- [ ] Instructions are specific (exact URLs, anchor text, location)
- [ ] Hub-and-spoke architecture is logical
- [ ] Anchor text is natural and keyword-relevant
- [ ] No recommendations to over-link (max 3-5 internal links per 1000 words)
- [ ] New pages have at least 2-3 internal links pointing to them

## Output Schema

```yaml
output_schema_version: "1.0.0"
internal_links:
  site: string
  pages_analyzed: number
  issues_found: number
  links_to_add: number

  orphan_pages: string[] # Pages with zero/few inlinks
  hub_pages: string[] # Identified hub pages

  link_actions:
    - source_url: string # Page to add the link ON
      target_url: string # Page to link TO
      anchor_text: string # Suggested anchor text
      location: string # Where in the content
      priority: string # "P0" | "P1" | "P2"
      reason: string

  link_structure: # Current state summary
    total_pages: number
    avg_inlinks: number
    avg_outlinks: number
    max_depth: number

chain_metadata:
  skill_slug: "internal-linking-optimizer"
  stage: "analytics"
  timestamp: string
  suggested_next:
    - "seo-audit"
    - "content-decay-detector"
    - "affiliate-blog-builder"
```

## Output Format

```
## Internal Link Audit: [Site]

### Structure Overview
- **Pages analyzed:** XX
- **Orphan pages:** XX (need links urgently)
- **Hub pages:** XX
- **Links to add:** XX
- **Average inlinks per page:** X.X

### Orphan Pages (P0 — fix immediately)
These pages have no/few internal links and are invisible to Google:
1. [URL] — [title] — 0 inlinks
2. [URL] — [title] — 1 inlink

### Link Actions

#### P0 — Critical
| Source Page | → | Target Page | Anchor Text | Location |
|---|---|---|---|---|
| [source] | → | [target] | "[anchor]" | After paragraph about [topic] |

#### P1 — High
[same table]

#### P2 — Maintenance
[same table]

### Hub-and-Spoke Health
| Hub Page | Expected Spokes | Linked Spokes | Missing Links |
|---|---|---|---|
| [hub] | XX | XX | [list missing] |

### Quick Wins
1. [Easiest high-impact link to add]
2. [Second easiest]
3. [Third]
```

## Error Handling

- **No site URL**: "I need your site URL to analyze internal links."
- **Site not indexed**: "This site doesn't appear to be indexed. Check robots.txt and sitemap."
- **Too few pages**: "With only [X] pages, focus on creating more content first. Internal linking becomes powerful at 10+ pages."
- **No hub pages identifiable**: "I can't identify clear hub pages. Run `keyword-cluster-architect` first to define your topic structure."

## Examples

**Example 1:** "Audit my blog's internal links"
→ Discover pages, map structure, find orphan pages, generate specific linking instructions with anchor text and placement.

**Example 2:** "I just published a new article, what should I link to it?"
→ Identify 3-5 existing pages that should link to the new article, with specific anchor text and paragraph locations.

**Example 3:** "Optimize internal links based on my keyword clusters" (after keyword-cluster-architect)
→ Use cluster structure to define ideal hub-spoke links. Compare current vs ideal. Generate gap-filling instructions.

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Internal linking directly increases organic traffic to your money pages (pages with affiliate links). Fixing orphan pages typically increases their organic traffic by 30-100% within 4-6 weeks. If an orphan page earns $100/month, proper linking can push it to $130-200/month
- **Benchmark**: Sites with optimized internal linking rank 20-40% higher for target keywords. Every hub-spoke connection you add is a signal to Google that your content is authoritative
- **Key metric to track**: Organic traffic to money pages (pages containing affiliate links) — measure before and after internal link optimization. Target: 30%+ traffic increase within 6 weeks

### Do This Right Now (15 min)

1. **Fix the top 3 P0 (Critical) links first** — these are orphan money pages getting zero internal link juice
2. Open each source page, find the suggested paragraph, and add the internal link with the recommended anchor text
3. Submit the updated pages to Google Search Console for re-indexing: `Inspect URL → Request Indexing`
4. Set a monthly reminder to re-run this audit

### Track Your Results

After 4 weeks: check Google Search Console for the orphan pages. Did impressions/clicks increase? After 8 weeks: did rankings improve for target keywords? Internal linking compounds — each optimization makes the next one more powerful.

> **Next step — copy-paste this prompt:**
> "Run an SEO audit on my site to find more optimization opportunities" → runs `seo-audit`

## Flywheel Connections

### Feeds Into

- `content-decay-detector` (S3) — pages with weak link structure may be decaying
- `seo-audit` (S6) — link structure is a key SEO factor
- `affiliate-blog-builder` (S3) — new articles need immediate internal links

### Fed By

- `keyword-cluster-architect` (S3) — cluster structure defines ideal link architecture
- `affiliate-blog-builder` (S3) — new content that needs linking
- `seo-audit` (S6) — identifies pages with link structure issues

### Feedback Loop

- `seo-audit` (S6) tracks ranking changes after link optimization → measure impact of internal linking changes

## References

- `shared/references/seo-strategy.md` — Hub-and-spoke linking rules, anchor text rules, link equity flow
- `shared/references/flywheel-connections.md` — Master connection map
