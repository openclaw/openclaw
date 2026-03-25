---
name: listicle-generator
description: >
  Write "Top N best..." listicle articles for affiliate marketing with mini-reviews, pricing,
  pros/cons, and CTAs per entry. Triggers on: "write a best of list", "top 10 [category] tools",
  "best [product category] article", "roundup post", "listicle about [category]",
  "write a top tools article", "best [N] alternatives to [product]", "product roundup",
  "write a tools comparison list", "best software for [use case]", "top picks for [category]".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "listicle", "top-lists"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# Listicle Generator

Write "Top N Best [Category]" roundup articles that rank on Google, capture featured snippets, and drive affiliate conversions across multiple products. Each list entry is a self-contained mini-review with features, pricing, pros/cons, audience fit, and a CTA. The article is structured to win both the featured snippet and the "People Also Ask" box.

## When to Use

- User wants to cover an entire product category with multiple affiliate links
- User says "best", "top", "roundup", "list of", or mentions a number with a category
- User wants to capture high-volume generic keywords ("best email marketing tools") vs. specific product searches
- User has multiple affiliate programs in the same category and wants one article to cover them all
- User wants an article format that benefits from regular updates (add/remove products as market evolves)

## Workflow

### Step 1: Determine List Parameters

Parse the user's request for:

- **Category**: what type of product (e.g., "email marketing tools", "AI video generators")
- **List size (N)**: explicitly stated number, or auto-select based on category depth
  - Niche/specialized categories: 5-7 products
  - Broad/competitive categories: 7-10 products
  - Very broad (e.g., "project management tools"): 10-12 products
- **Target audience**: inferred from category + any context clues (beginners, enterprises, specific industries)
- **Year**: always use current year in the title for freshness signal

**If no affiliate product is specified:**

- Ask: "Which product are you promoting? I'll feature it prominently in the list."
- If user says to proceed anyway, generate a balanced list and note where they should insert their affiliate link.

### Step 2: Research the Product Landscape

Use `web_search` to build the product list:

1. **Seed query**: `"best [category] tools [year]" site:g2.com OR site:capterra.com OR site:trustradius.com`
2. **Validate with traffic**: `"best [category]"` — check autocomplete for common phrasings
3. **Find affiliate programs**: `"[category] affiliate program"` — identify which products offer commissions

For each candidate product, gather:

- Product name and one-line description
- Starting price and free plan availability
- G2/Capterra rating (if available)
- The one thing it does best (unique angle)
- Who it's primarily designed for

**Affiliate prioritization rules:**

- Position the user's affiliate product at #1 or #2 (never lower than #3 unless it genuinely cannot be defended in the top 3)
- #1 position gets the most clicks — use it for the highest-commission or best-converting product
- If the user has multiple affiliate programs, spread them in positions 1, 2, and 4
- Non-affiliate products fill the remaining slots to make the list credible and balanced

### Step 3: Plan the Article Structure

Map out every section before writing:

**Article structure:**

1. Title (with year, number, category)
2. FTC disclosure
3. Introduction (150-200 words)
4. "At a Glance" summary table
5. Evaluation criteria (H2)
6. Individual product entries × N (H2 each)
7. Comparison table (all products × key dimensions)
8. How to Choose (H2)
9. FAQ (H2)
10. Final Recommendation (H2)

**Per-entry structure** (400-600 words each):

- H2: `[Rank]. [Product Name] — [One-line Value Prop]`
- Opening paragraph: what it is, who made it, why it's on this list
- Key features section (3-5 bullet points)
- Pricing table (free / starter / pro / enterprise)
- Pros list (4-5 bullets)
- Cons list (2-3 bullets — be honest, builds trust)
- Best for: one sentence naming the ideal user
- Affiliate CTA button: `[Try [Product] free →](url)`

### Step 4: Write the Full Article

**Title formula:** `[N] Best [Category] Tools in [Year] (Ranked and Reviewed)`
Alternative: `Best [Category] Software: Top [N] Picks for [Year]`

**Introduction (150-200 words):**

- Open with the core problem this category solves
- Mention how many tools you evaluated and your selection criteria
- Name-drop 2-3 products from the list to signal comprehensiveness
- End with a transition: "Here are the [N] best options I found."

**"At a Glance" Table** (immediately after intro, captures featured snippet):

```
| Tool | Best For | Starting Price | Free Plan |
|---|---|---|---|
| [Product 1] | [Use case] | $X/mo | ✅ |
| [Product 2] | [Use case] | $Y/mo | ❌ |
```

**Evaluation Criteria (H2, before the list):**
List the 4-6 criteria used to rank products. This builds credibility and explains why your #1 pick is #1.
Example criteria: ease of use, feature depth, pricing value, customer support quality, integration ecosystem, scalability.

**Individual Product Entries:**
Write each entry following the per-entry structure above. Vary the opening sentence — don't start every entry the same way. Include specific, verifiable details (actual feature names, real pricing tiers, concrete limitations) — not generic praise.

**Master Comparison Table:**
After all product entries, include a comprehensive feature matrix:

```
| Feature | [P1] | [P2] | [P3] | [P4] | [P5] |
|---|---|---|---|---|---|
| Free plan | ✅ | ❌ | ✅ | ⚠️ | ✅ |
| [Key feature] | ✅ | ✅ | ❌ | ✅ | ❌ |
| [Key feature] | ⭐ Best | Good | Limited | Good | Basic |
| Starting price | $X | $Y | $Z | $A | Free |
```

**How to Choose (H2, 300-400 words):**
A decision framework for readers who are still unsure after reading the list:

- "If you're a beginner with a tight budget → [Product X]"
- "If you need [specific feature] → [Product Y]"
- "If you're scaling a team → [Product Z]"
- "If you're migrating from [common competitor] → [Product A]"

**FAQ Section (5-7 questions):**

- "What is the best [category] tool?"
- "What is the cheapest [category] tool?"
- "What [category] tool has the best free plan?"
- "Is [top product] worth it?"
- "How do I choose [category] software?"

**Final Recommendation (H2):**

- Restate the #1 pick with a 2-sentence reason
- Give a backup pick for a different audience
- Strong CTA: `**Start with [Product] — it's free to try.** [Get started →](affiliate_url)`

### Step 5: Format Output

**Part 1: SEO Metadata**

```
---
SEO METADATA
---
Title: [title with year and number]
Slug: best-[category-slug]-tools
Meta Description: [150-160 chars, include number + year + top product name]
Target Keyword: best [category] tools
Secondary Keywords: [category] software, [product 1] review, [product 2] alternatives, top [category] [year]
Word Count: [actual]
Format: listicle
Products: [N]
---
```

**Part 2: Full Article**
Complete markdown ready to publish.

**Part 3: Supplementary Data**

- FAQ questions for schema markup
- Image suggestions (product screenshots, comparison screenshots)
- All products with affiliate URLs flagged
- Update reminder: "This article should be refreshed every 6 months to keep rankings."

## Input Schema

```yaml
category: # REQUIRED — product category to cover
  name: string # e.g., "AI video generators", "email marketing platforms"
  tags: string[] # Optional — helps with research targeting

primary_product: # OPTIONAL but recommended — the affiliate product to feature at #1
  name: string
  description: string
  reward_value: string
  url: string # Affiliate link
  reward_type: string
  cookie_days: number
  tags: string[]

additional_affiliates: # OPTIONAL — other affiliate products to include in the list
  - name: string
    url: string
    reward_value: string

list_size: number # OPTIONAL — how many products (5-12). Default: auto-select.

target_audience:
  string # OPTIONAL — "beginners" | "enterprise" | "freelancers" | "agencies"
  # Default: inferred from category

year: number # OPTIONAL — year for title/freshness. Default: current year.

target_keyword: string # OPTIONAL — override default keyword
tone: string # OPTIONAL — "conversational" | "professional". Default: "conversational"
```

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure appears before product entries
- [ ] "At a Glance" table present with Tool/Best For/Price/Free Plan columns
- [ ] Primary affiliate product ranked #1-3 (never buried lower)
- [ ] Each entry has: key features, pricing, pros, cons, "best for" sentence
- [ ] Title includes current year for recency signal

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
article:
  title: string
  slug: string
  meta_description: string
  target_keyword: string
  format: "listicle"
  content: string
  word_count: number
  product_count: number

products_featured:
  - name: string
    url: string
    rank: number # Position in the list (1 = top)
    role: string # "affiliate-primary" | "affiliate-secondary" | "editorial"
    reward_value: string

seo:
  secondary_keywords: string[]
  at_a_glance_table: string # Markdown table — can be extracted for featured snippet
  faq_questions:
    - question: string
      answer: string
  image_suggestions:
    - description: string
      alt_text: string
      placement: string

update_schedule:
  recommended_frequency: string # "every 6 months" for most categories
  items_to_check: string[] # What to verify on next update
```

## Output Format

Present as three sections:

1. **SEO Metadata** — fenced block for copy-paste into blog CMS
2. **Article** — full markdown, immediately publishable
3. **Supplementary** — FAQ schema, image suggestions, affiliate URLs, update notes

Target word count: 3,000-5,000 words depending on list size (aim for 400-500 words per product entry plus structural sections).

## Error Handling

- **No category provided**: "What category of products should this listicle cover? For example: 'best email marketing tools' or 'top AI writing assistants'."
- **No affiliate product specified**: Generate a balanced editorial list. Flag in output: "Affiliate link not set — insert your tracking URL for [top pick] before publishing."
- **Category too broad** ("best software"): Narrow it. Ask: "That's very broad — can you narrow it down? For example: 'best project management software for small teams'."
- **Category too niche** (fewer than 5 good products exist): Reduce list size and be transparent: "Only 5 strong options exist in this niche — I've included all of them."
- **Product research returns low-quality results**: Use web_search with 3 different query variations before giving up. Fallback: base entries on official product pages + G2 reviews.

## Examples

**Example 1: Standard category listicle**
User: "Write a top 10 best AI video tools article"
Action: category="AI video generators", list_size=10, research top tools, position user's affiliate at #1, write 4,500-word listicle targeting "best ai video tools [year]".

**Example 2: Niche with specific audience**
User: "Best email marketing tools for e-commerce, I'm promoting Klaviyo"
Action: category="email marketing for e-commerce", primary_product=Klaviyo, target_audience="e-commerce store owners", list_size=7, write article with Klaviyo at #1.

**Example 3: Alternatives format**
User: "Write a 'best alternatives to Mailchimp' article"
Action: Treat as listicle where Mailchimp is the incumbent being replaced. Title: "7 Best Mailchimp Alternatives in [Year] (Cheaper + More Powerful)". Position user's affiliate at #1 as top alternative.

**Example 4: Chained from S1**
User: "Now write a roundup post for the category"
Context: S1 returned Semrush in the SEO tools category
Action: category=SEO tools, primary_product=Semrush, auto-select list_size=8, write "Best SEO Tools [year]" with Semrush at #1.

## References

- `shared/references/ftc-compliance.md` — FTC disclosure text. Read before Step 4.
- `shared/references/affiliate-glossary.md` — Terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `landing-page-creator` (S4) — featured products for landing pages
- `content-pillar-atomizer` (S2) — listicle as pillar content to atomize
- `internal-linking-optimizer` (S6) — new listicle needs internal links

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` as primary product
- `keyword-cluster-architect` (S3) — commercial intent clusters for listicle topics

### Feedback Loop

- `seo-audit` (S6) tracks listicle rankings → identify which list formats and sizes rank best

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
  skill_slug: "listicle-generator"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "landing-page-creator"
    - "content-pillar-atomizer"
    - "internal-linking-optimizer"
```
