---
name: seo-audit
description: >
  Audit affiliate blog posts and landing pages for SEO issues. Triggers on:
  "audit my blog post for SEO", "check my SEO", "SEO review", "improve my rankings",
  "SEO checklist", "on-page SEO audit", "keyword optimization check",
  "why isn't my page ranking", "SEO score", "content quality audit",
  "check my meta tags", "internal linking audit", "quick SEO wins".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "analytics", "optimization", "tracking", "seo", "technical-seo"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S6-Analytics
---

# SEO Audit

Audit affiliate blog posts and landing pages for SEO issues — on-page optimization, keyword usage, meta tags, content quality signals, affiliate link attributes, and internal linking. Output is a 10-dimension SEO scorecard with a prioritized fix-it checklist.

## Stage

S6: Analytics — 53% of all website traffic comes from organic search. For affiliate bloggers, SEO is the most sustainable traffic source — but most affiliate content has basic SEO mistakes that tank rankings. This skill catches those mistakes and provides quick wins.

## When to Use

- User has a blog post or landing page and wants an SEO review
- User asks "why isn't my page ranking?" or "check my SEO"
- User wants to improve search rankings for affiliate content
- User says "SEO audit", "SEO checklist", "on-page optimization"
- User wants to check affiliate link attributes (nofollow, sponsored)
- Chaining from S3 (blog) or S4 (landing): audit content before or after publishing

## Input Schema

```yaml
content:
  string # REQUIRED — the content to audit (markdown, HTML, or URL)
  # If URL, will attempt to fetch and analyze

target_keyword:
  string # REQUIRED — primary keyword to optimize for
  # (e.g., "best AI video tools", "HeyGen review")

content_type:
  string # OPTIONAL — "blog_post" | "landing_page"
  # Default: "blog_post"

competitor_urls: # OPTIONAL — competitor pages to compare against
  - string # e.g., ["competitor.com/heygen-review"]

secondary_keywords: # OPTIONAL — additional keywords to check
  - string # e.g., ["AI video generator", "HeyGen pricing"]
```

**Chaining context**: If S3 (blog) or S4 (landing page) was run in the same conversation, pull the generated content directly for audit. The user should not have to paste content just generated.

## Workflow

### Step 1: Analyze Content Structure

Check:

- **Word count**: Is it competitive? (blog: 1500+ words, landing: varies)
- **Heading structure**: H1 present and unique? H2/H3 hierarchy logical?
- **Paragraph length**: Short paragraphs for readability?
- **Content depth**: Does it cover the topic comprehensively?

### Step 2: Check Keyword Usage

Analyze:

- **Title tag**: Contains target keyword? Under 60 characters?
- **H1**: Contains target keyword?
- **First 100 words**: Keyword appears naturally?
- **Keyword density**: 1-2% optimal (not stuffing, not absent)
- **Keyword in subheadings**: At least one H2 contains keyword or variant?
- **LSI keywords**: Related terms present for topical depth?

### Step 3: Evaluate Meta Tags

Check:

- **Title tag length**: 50-60 characters optimal
- **Meta description**: Present? 150-160 characters? Contains keyword? Compelling?
- **OG tags**: Open Graph tags for social sharing
- **Canonical URL**: Present and correct?

### Step 4: Check E-E-A-T Signals

Evaluate:

- **Experience**: First-person experience with the product?
- **Expertise**: Author credentials or demonstrated knowledge?
- **Authoritativeness**: Citing sources, linking to official pages?
- **Trustworthiness**: Transparent disclosure, balanced (pros AND cons)?

### Step 5: Check Affiliate Link Attributes

Verify:

- All affiliate links have `rel="nofollow sponsored"` (Google requirement)
- Links are not cloaked in a way that violates search guidelines
- FTC disclosure is present and above the fold
- Links open in new tab (`target="_blank"`) for UX

### Step 6: Check Internal Linking

Evaluate:

- Links to related content on the same site?
- Anchor text is descriptive (not "click here")?
- Table of contents for long content?

### Step 7: Score on 10 Dimensions

Rate each 1-10:

1. Keyword optimization
2. Content depth and quality
3. Title tag and meta description
4. Heading structure
5. E-E-A-T signals
6. Affiliate link compliance
7. Internal linking
8. Readability and formatting
9. Mobile friendliness indicators
10. Technical SEO basics

### Step 8: Generate Fix-It Checklist

Prioritize fixes by impact:

- **Quick wins**: Fix in 5 minutes, big impact (meta tags, keyword in H1)
- **Medium effort**: Fix in 30 minutes (add sections, improve depth)
- **Major revision**: Fix in 2+ hours (restructure content, add original research)

### Step 9: Self-Validation

Before presenting output, verify:

- [ ] All 10 SEO dimensions scored (1-10 each)
- [ ] Overall score is weighted sum of dimension scores
- [ ] Issues prioritized: quick_win → medium → major
- [ ] Each fix is specific and actionable (not generic advice)
- [ ] Keyword density recommendation is 1-2% (not higher)

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
audit:
  url_or_title: string
  target_keyword: string
  overall_score: number # out of 100 (sum of 10 dimensions × 10)
  word_count: number

scores:
  - dimension: string
    score: number # 1-10
    status: string # "good" | "needs_work" | "critical"
    notes: string

issues:
  - priority: string # "quick_win" | "medium" | "major"
    dimension: string
    issue: string
    fix: string # specific action to take
    impact: string # "high" | "medium" | "low"

checklist:
  - task: string
    priority: string
    done: boolean # always false (user checks off)
```

## Output Format

1. **SEO Scorecard** — table with 10 dimensions, scores, and status
2. **Overall Score** — X/100 with assessment (Excellent >80, Good 60-80, Needs Work 40-60, Critical <40)
3. **Quick Wins** — fixes that take <5 minutes and have high impact
4. **Full Fix-It Checklist** — all issues ordered by priority with specific actions
5. **Competitor Comparison** — brief notes if competitor URLs were provided

## Error Handling

- **No content provided**: "Paste the content of your blog post or landing page. I'll audit it for SEO issues and give you a prioritized fix-it list."
- **No target keyword**: "What keyword are you trying to rank for? (e.g., 'HeyGen review', 'best AI video tools'). This helps me check keyword usage and optimization."
- **Content is too short (<300 words)**: "This content is quite short (X words). For competitive keywords, aim for 1,500+ words. I'll audit what's here, but content depth is likely your biggest SEO issue."
- **URL provided but cannot be fetched**: "I couldn't fetch that URL. Paste the page content directly and I'll audit it."

## Examples

### Example 1: Blog post with common issues

**User**: "Audit this blog post for 'best AI video tools': [pastes 2000-word blog post]"
**Action**: Score each dimension. Common findings: keyword not in H1 (fix: add to title), affiliate links missing `rel="nofollow sponsored"` (fix: add attributes), no meta description (fix: write one), thin intro section (fix: expand first paragraph). Overall score: 62/100. Quick wins: meta description, H1 keyword, link attributes.

### Example 2: Landing page audit

**User**: "Check the SEO on my HeyGen landing page" [content from S4 in conversation]
**Action**: Pull landing page content from S4 output. Note: landing pages are typically not SEO-optimized (they're conversion-focused). Score accordingly — different expectations for landing pages vs blog posts. Focus on: title tag, meta description, canonical, affiliate link compliance.

### Example 3: Competitive comparison

**User**: "Audit my Semrush review and compare to these competitor pages: [competitor URLs]"
**Action**: Audit user's content first. Then use `web_search` or `web_browse` to analyze competitor content structure (word count, headings, topics covered). Identify content gaps — topics competitors cover that the user doesn't. Recommend additions to improve competitiveness.

## References

- `shared/references/ftc-compliance.md` — FTC disclosure requirements for affiliate content. Checked in Step 5.
- `shared/references/affiliate-glossary.md` — SEO and affiliate terminology. Referenced throughout.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `monopoly-niche-finder` (S1) — ranking data reveals niches you're already winning in
- `keyword-cluster-architect` (S3) — ranking gaps reveal keyword opportunities
- `content-decay-detector` (S3) — declining pages to investigate
- `internal-linking-optimizer` (S6) — link structure issues to fix

### Fed By

- `github-pages-deployer` (S5) — deployed site URL to audit
- `affiliate-blog-builder` (S3) — published articles to audit

### Feedback Loop

- SEO audit results feed back to S3 Blog (content improvements) and S1 Research (niche opportunities from ranking data) — closing the SEO flywheel

```yaml
chain_metadata:
  skill_slug: "seo-audit"
  stage: "analytics"
  timestamp: string
  suggested_next:
    - "content-decay-detector"
    - "internal-linking-optimizer"
    - "keyword-cluster-architect"
```
