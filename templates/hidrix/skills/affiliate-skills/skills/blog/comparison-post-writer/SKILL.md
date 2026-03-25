---
name: comparison-post-writer
description: >
  Write "X vs Y" comparison blog posts that help readers choose between two competing products.
  Triggers on: "write a comparison post", "X vs Y blog post", "compare [product A] and [product B]",
  "which is better [A] or [B]", "head to head comparison", "[product] vs [product] article",
  "comparison review", "write a versus article", "side by side comparison blog",
  "which should I choose [A] or [B]", "compare these two products for my blog".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "comparison", "versus"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# Comparison Post Writer

Write high-converting "X vs Y" comparison blog posts that rank on Google and help readers make a confident buying decision. Each post includes a feature comparison table, individual product breakdowns, pros and cons, a clear winner recommendation, and affiliate CTAs placed at maximum-intent moments.

## When to Use

- User wants to compare two or three competing products side by side
- User has two affiliate programs and wants a single article that covers both
- User says "vs", "versus", "compare", "which is better", "side by side"
- User wants to capture high-intent search traffic (X vs Y searches convert at 2-3x the rate of generic reviews)
- User has a product from S1 and wants to frame it against competitors

## Workflow

### Step 1: Identify Products to Compare

Parse the user's request for product names. You need a minimum of 2 and a maximum of 3 products.

**If only 1 product is provided:**

- Use `web_search` to find the top 1-2 competitors
- Search: `"[product name] alternatives" OR "[product name] vs" site:g2.com OR site:capterra.com OR site:trustradius.com`
- Pick the competitors with the most head-to-head search volume

**If 3+ products are provided:**

- Keep all 3 if they are genuinely comparable
- If the user listed 4+, ask which 2-3 to focus on — more than 3 makes the comparison unwieldy

**Affiliate priority**: The user's affiliate product goes first (featured position). If both products have affiliate links, feature the higher-commission one in the "winner" slot unless the product genuinely loses on quality.

### Step 2: Research Both Products

For each product, use `web_search` to gather:

1. **Pricing**: starting price, tiers, free trial availability
2. **Key features**: 8-12 features that matter to buyers
3. **Target audience**: who uses this product and why
4. **Known weaknesses**: common complaints on G2, Capterra, Reddit, or Trustpilot
5. **Unique differentiator**: one thing this product does better than everyone else
6. **Search volume signal**: `"[product A] vs [product B]"` — check if autocomplete shows this is a real query

Search queries to run per product:

- `"[product name] review [year]"`
- `"[product name] pricing"`
- `"[product name] pros cons"`

### Step 3: Build the Comparison Framework

Determine the 6-10 comparison dimensions that matter most for this product category. These should be:

- Directly relevant to buyer decisions (not vanity features)
- Measurable or clearly differentiable between products
- Things that appear in search queries ("does X have [feature]?")

**Example dimensions by category:**

- Email tools: deliverability, automation, templates, integrations, pricing/contacts ratio, free plan
- SEO tools: keyword database size, backlink data, site audit depth, reporting, API access, pricing
- Video tools: resolution, AI avatars, voice cloning, templates, render speed, watermark on free plan
- Project management: task limits on free, Gantt chart, time tracking, automations, integrations, mobile app

Assign a winner per dimension based on research. Mark ties where genuine.

### Step 4: Determine the Narrative Angle

Choose one of three angles based on what the data shows:

| Angle            | When to use                                    | Headline formula                                              |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| **Clear winner** | One product is genuinely better for most users | "[A] vs [B]: [A] Wins for Most, But [B] Is Better If..."      |
| **It depends**   | Products serve different audiences             | "[A] vs [B]: Which Is Right for You? (Honest Comparison)"     |
| **Upset**        | Lesser-known product beats the market leader   | "[A] vs [B]: Why [Lesser-Known] Is Actually Better in [Year]" |

Default to "clear winner" — readers want a recommendation, not a non-answer.

### Step 5: Write the Article

Write the full comparison post following this exact structure:

**1. FTC Disclosure** (3 lines, above the fold)
Read `shared/references/ftc-compliance.md` and use the medium format. Insert immediately after the title.

**2. Introduction** (150-250 words)

- Open with the core tension: why this is a hard choice
- State who each product is best suited for (one sentence each)
- End with: "By the end of this post, you'll know exactly which one to pick."
- Include target keyword naturally in the first 100 words

**3. Quick Verdict Box** (immediately after intro)
A scannable summary for readers who won't read the full article:

```
**Quick Verdict**
- Best overall: [Product A] — [one-line reason]
- Best for [use case]: [Product B] — [one-line reason]
- Best for budget: [Product X]
- Skip if: [edge case where neither works]
```

**4. Product Overviews** (200-300 words each)
One H2 section per product:

- What it is and what it does
- Who built it and when (brief credibility context)
- The one thing it does better than anyone else
- Starting price and free trial info
- Affiliate CTA: `[Try [Product] free →](affiliate_url)`

**5. Feature Comparison Table**
A full markdown table with all comparison dimensions:

```
| Feature | [Product A] | [Product B] |
|---|---|---|
| [Dimension 1] | ✅ Yes | ❌ No |
| [Dimension 2] | ⭐ Better | Good |
| Price | $X/mo | $Y/mo |
```

Use ✅ / ❌ / ⚠️ (partial) for binary features. Use descriptive text for nuanced ones. Bold the winner per row.

**6. Deep-Dive Sections** (one H2 per key dimension, 3-4 total)
Pick the 3-4 dimensions that drive 80% of buying decisions. For each:

- Explain what the feature does and why it matters
- Compare both products specifically (not generically)
- Include a sub-verdict: "Winner: [Product] because..."

**7. Pricing Breakdown**

- Table showing all pricing tiers for both products
- Calculate cost at 3 usage levels: starter, growing, scale
- Highlight free plan differences
- Note which has better value per feature

**8. Pros and Cons**
Two H3 sections (one per product), each with 4-6 bullet points per list.

**9. Who Should Choose Each Product**
Two H3 sections with bullet lists:

- "Choose [Product A] if you..."
- "Choose [Product B] if you..."
  Be specific — job titles, use cases, budget ranges, team sizes.

**10. The Verdict** (200-300 words)

- State the winner clearly: "[Product A] is the better choice for most people."
- Explain why in 2-3 sentences
- Acknowledge the exception case where [Product B] wins
- Final affiliate CTA (strong format): `**Get started with [Product A] →**(affiliate_url)`
- If [Product B] also has affiliate link: secondary CTA below

**11. FAQ Section** (5-7 questions)
Address the real questions people type into Google:

- "Is [Product A] better than [Product B]?"
- "Which is cheaper, [A] or [B]?"
- "Does [Product A] offer a free trial?"
- "Can I switch from [Product B] to [Product A]?"
- "Which has better customer support?"

### Step 6: Format Output

Produce output in three parts:

**Part 1: SEO Metadata**

```
---
SEO METADATA
---
Title: [title]
Slug: [product-a]-vs-[product-b]
Meta Description: [150-160 chars comparing both products with clear angle]
Target Keyword: [product-a] vs [product-b]
Secondary Keywords: [product-a] review, [product-b] alternatives, best [category] tool, [product-a] pricing
Word Count: [actual]
Format: comparison
Winner: [product name]
---
```

**Part 2: Full Article**
Complete markdown ready to paste into any blog platform.

**Part 3: Supplementary Data**
FAQ schema questions, image suggestions (comparison screenshots), products featured with affiliate URLs, next steps.

## Input Schema

```yaml
product_a: # REQUIRED — the primary affiliate product
  name: string
  description: string
  reward_value: string # e.g., "30% recurring"
  url: string # Affiliate link
  reward_type: string # "recurring" | "one-time" | "tiered"
  cookie_days: number
  tags: string[]

product_b: # REQUIRED — the product to compare against
  name: string
  url: string # Affiliate link if available, otherwise homepage
  description: string # Optional — will research if missing

product_c: # OPTIONAL — third product for 3-way comparison
  name: string
  url: string
  description: string

target_keyword: string # OPTIONAL — default: "[product_a] vs [product_b]"
tone:
  string # OPTIONAL — "conversational" | "technical" | "professional"
  # Default: "conversational"
angle:
  string # OPTIONAL — "clear-winner" | "it-depends" | "upset"
  # Default: auto-detected from research
```

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure above fold, medium format
- [ ] Comparison table has 6-10 dimensions with ✅/❌/⚠️ indicators
- [ ] Both products get fair, balanced coverage
- [ ] Winner stated clearly in verdict section
- [ ] Word count is 2,500-3,500 words

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
article:
  title: string
  slug: string # e.g., "heygen-vs-synthesia"
  meta_description: string
  target_keyword: string
  format: "comparison"
  content: string # Full markdown article
  word_count: number
  winner: string # Name of the recommended product

comparison:
  dimensions: string[] # The features compared
  dimension_winners: # Who won each dimension
    - dimension: string
      winner: string # "product_a" | "product_b" | "tie"

products_featured:
  - name: string
    url: string
    role: string # "primary" | "compared"
    reward_value: string

seo:
  secondary_keywords: string[]
  faq_questions:
    - question: string
      answer: string
  image_suggestions:
    - description: string
      alt_text: string
```

## Output Format

Present as three sections:

1. **SEO Metadata** — fenced block for copy-paste into WordPress/Yoast/Ghost
2. **Article** — complete markdown, immediately publishable
3. **Supplementary** — FAQ schema, image suggestions, products list, next steps

Target word count: 2,500-3,500 words. Longer for complex SaaS tools with many features.

## Error Handling

- **Only 1 product provided**: Auto-search for top 2 competitors. Inform user: "I found [B] and [C] as the main competitors — using those. Let me know if you want different ones."
- **No affiliate link for product_b**: Use homepage URL. Note in output: "No affiliate link for [B] — using homepage. You can still earn on [A] clicks."
- **Products in completely different categories**: Stop and ask — comparing an email tool to a project management tool is not useful.
- **Controversial product (MLM, scam accusations)**: Add warning note: "This product has mixed reputation signals. Review carefully before publishing — your credibility is at stake."
- **Tie on most dimensions**: Use "it depends" angle. Never force a winner that isn't real — readers trust honest comparisons more.

## Examples

**Example 1: Two affiliate products**
User: "Write a comparison post: HeyGen vs Synthesia"
Action: product_a=HeyGen (affiliate), product_b=Synthesia (affiliate), research both, detect angle=clear-winner (or it-depends based on data), write 3,000-word comparison targeting "heygen vs synthesia".

**Example 2: Chained from S1**
User: "Compare it with its top competitor"
Context: S1 returned HeyGen as recommended_program
Action: product_a=HeyGen from S1 output, web_search for top competitor, write comparison.

**Example 3: Three-way comparison**
User: "HeyGen vs Synthesia vs Colossyan comparison post"
Action: Three-way comparison, determine winner + runners-up, write 3,500-4,000 word article with side-by-side table.

**Example 4: Underdog angle**
User: "Compare Ahrefs vs Ubersuggest — I'm promoting Ubersuggest"
Action: product_a=Ubersuggest (affiliate), product_b=Ahrefs, angle=upset (lesser-known vs market leader), frame Ubersuggest as the budget-friendly winner for specific use cases.

## References

- `shared/references/ftc-compliance.md` — FTC disclosure text. Read in Step 5.
- `shared/references/affitor-branding.md` — Do NOT add Affitor branding to blog body. Only applies to landing pages.
- `shared/references/affiliate-glossary.md` — Terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `landing-page-creator` (S4) — comparison data feeds comparison landing pages
- `content-pillar-atomizer` (S2) — comparison article as pillar to atomize
- `internal-linking-optimizer` (S6) — new comparison needs internal links

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` as primary product
- `keyword-cluster-architect` (S3) — commercial intent clusters for comparison topics
- `competitor-spy` (S1) — competitor product data

### Feedback Loop

- `seo-audit` (S6) tracks comparison article rankings → identify which comparison angles rank best

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (if S4 offer skills ran)

Any NO → rewrite before delivering.

```yaml
chain_metadata:
  skill_slug: "comparison-post-writer"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "landing-page-creator"
    - "content-pillar-atomizer"
    - "internal-linking-optimizer"
```
