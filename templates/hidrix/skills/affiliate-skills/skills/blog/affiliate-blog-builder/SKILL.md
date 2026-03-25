---
name: affiliate-blog-builder
description: >
  Write SEO-optimized affiliate blog articles, product reviews, comparison posts, listicles,
  and how-to guides. Triggers on: "write a blog post about", "review of [product]",
  "best [category] article", "comparison blog", "affiliate blog", "SEO article",
  "write a review", "product roundup", "blog content for affiliate", "how to use [product] blog post",
  "listicle about [category]", "[product] vs [product] blog", "content for my affiliate site".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "blog", "wordpress"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# Affiliate Blog Builder

Write full SEO-optimized blog articles that rank on Google and drive passive affiliate revenue. Supports four formats: product review, head-to-head comparison, best-of listicle, and how-to guide. Each article includes keyword strategy, structured headings, comparison tables, CTAs, FAQ schema, and FTC-compliant disclosure.

## Stage

S3: Blog — The highest-value content type in the affiliate funnel. Blog articles rank on Google, drive organic traffic for months/years, and convert at higher rates than social posts because readers have high purchase intent.

## When to Use

- User wants to write a blog post reviewing an affiliate product
- User wants a comparison article (Product A vs Product B)
- User wants a "best of" listicle for a product category
- User wants a how-to tutorial that naturally promotes an affiliate product
- User has a product from S1 (affiliate-program-search) and wants to create long-form content
- User says anything like "write a blog", "SEO article", "product review post", "roundup post"

## Input Schema

```yaml
product:                    # REQUIRED — the affiliate product to feature
  name: string              # Product name (e.g., "HeyGen")
  description: string       # What it does
  reward_value: string      # Commission (e.g., "30% recurring")
  url: string               # Affiliate link URL
  reward_type: string       # "recurring" | "one-time" | "tiered"
  cookie_days: number       # Cookie duration
  tags: string[]            # e.g., ["ai", "video", "saas"]

format: string              # OPTIONAL — "review" | "comparison" | "listicle" | "how-to"
                            # Default: "listicle" (highest traffic potential)

compare_with: object[]      # OPTIONAL — competitors for comparison/listicle formats
  - name: string            # Competitor name
    description: string     # Brief description
    url: string             # URL (non-affiliate OK)
    pricing: string         # Starting price

target_keyword: string      # OPTIONAL — primary SEO keyword to target
                            # Default: auto-generated from product name + category

blog_platform: string       # OPTIONAL — "wordpress" | "ghost" | "hugo" | "astro" | "webflow" | "markdown"
                            # Default: "markdown" (universal)

tone: string                # OPTIONAL — "professional" | "conversational" | "technical"
                            # Default: "conversational"

word_count_target: number   # OPTIONAL — override default word count for the format
```

**Chaining from S1**: If `affiliate-program-search` was run earlier in the conversation, automatically pick up `recommended_program` from its output as the `product` input. The field mapping:

- `recommended_program.name` → `product.name`
- `recommended_program.description` → `product.description`
- `recommended_program.reward_value` → `product.reward_value`
- `recommended_program.url` → `product.url`
- `recommended_program.reward_type` → `product.reward_type`
- `recommended_program.cookie_days` → `product.cookie_days`
- `recommended_program.tags` → `product.tags`

If the user says "now write a blog about it" after running S1 — use the recommended program. No need to ask again.

## Workflow

### Step 1: Determine Format

Choose the article format based on user request or defaults:

| Signal                                                  | Format                                           |
| ------------------------------------------------------- | ------------------------------------------------ |
| User says "review", "my experience with"                | `review`                                         |
| User mentions two+ products, "vs", "compare"            | `comparison`                                     |
| User says "best", "top", "roundup", numbers             | `listicle`                                       |
| User says "how to", "tutorial", "guide", "step by step" | `how-to`                                         |
| No clear signal                                         | `listicle` (default — highest traffic potential) |

If `format = comparison` and `compare_with` is empty or has only 1 product:

- Use `web_search` to find 2-3 top competitors in the same category
- Search query: `"best alternatives to [product.name]" OR "[product.name] vs" site:g2.com OR site:capterra.com`

If `format = listicle` and `compare_with` is empty:

- Use `web_search` to find 4-6 products in the same category
- Search query: `"best [product category] tools [year]"`

### Step 2: SEO Framework

Read `references/seo-checklist.md` for the complete SEO guidelines. Then:

1. **Generate target keyword** (if not provided):
   - Review format: `[product name] review`
   - Comparison: `[product A] vs [product B]`
   - Listicle: `best [category] tools`
   - How-to: `how to [goal] with [product/category]`

2. **Generate secondary keywords** (3-5):
   - Use `web_search` for: `"[target keyword]" related searches` and "People Also Ask"
   - Include: `[product] pricing`, `[product] alternatives`, `[product] pros and cons`, `is [product] worth it`

3. **Build title** using the formula from seo-checklist.md matching the format

4. **Write meta description** (150-160 chars) following the checklist format

5. **Plan heading structure**:
   - Map out all H2/H3 headings before writing
   - Ensure target keyword appears in at least 2 H2s
   - Ensure secondary keywords appear in H3s
   - Follow the heading hierarchy from seo-checklist.md

6. **Generate slug** from target keyword (lowercase, hyphens, no stop words)

### Step 3: Write Article

Read `references/blog-templates.md` and use the template matching the chosen format. Then write the full article following these rules:

**Content Rules:**

- Follow the exact template structure for the chosen format
- Write in the specified `tone` (default: conversational)
- Hit the word count target for the format (review: 2-3.5K, comparison: 2.5-3.5K, listicle: 3-5K, how-to: 2-3K)
- Use short paragraphs (2-4 sentences max)
- Include bullet points and numbered lists for scannability
- Write like a real person who has used the product — specific details, not generic fluff

**Required Sections (all formats):**

- FTC disclosure near the top — read `shared/references/ftc-compliance.md` and use the **medium** format
- Comparison table (at least one, even in reviews — compare to alternatives)
- Pros and cons for every recommended product
- "Who is this best for?" audience targeting
- Pricing information with affiliate CTA
- FAQ section (3-5 questions)
- Final verdict with clear recommendation and affiliate CTA

**Affiliate CTA Placement (2-4 per article):**

1. After the pricing section
2. After a key feature demonstration
3. In the final verdict
4. Optionally: in a callout box after the "who is this for" section

**CTA Formats:**

- Soft: `[Try [Product] free →]([affiliate_url])`
- Medium: `**Ready to get started?** [Sign up for [Product] →]([affiliate_url])`
- Strong (verdict only): `**Our recommendation**: [Get [Product] here]([affiliate_url]) — [brief value prop].`

**Things to AVOID:**

- No Affitor branding in the article body (this is the user's blog, not ours)
- No "AI-generated" disclaimers (the user will edit and personalize)
- No placeholder text like "[insert your experience here]" — write complete content. If personal experience is needed, write realistic example scenarios clearly marked as examples
- No keyword stuffing — natural language only
- No false claims about products

### Step 4: Format Output

Produce the final output in this exact structure:

**Part 1: SEO Metadata Block**

```
---
SEO METADATA
---
Title: [SEO title]
Slug: [url-slug]
Meta Description: [150-160 chars]
Target Keyword: [primary keyword]
Secondary Keywords: [comma-separated list]
Word Count: [actual count]
Format: [review/comparison/listicle/how-to]
---
```

**Part 2: Full Article**
The complete markdown article ready to paste into any blogging platform.

**Part 3: Supplementary Data**

```
---
SUPPLEMENTARY
---
FAQ Questions (for schema markup):
1. [Question] → [Answer]
2. [Question] → [Answer]
...

Image Suggestions:
1. [Description] — alt: "[alt text]"
2. [Description] — alt: "[alt text]"
...

Products Featured:
- [Product 1]: [affiliate URL] (featured/mentioned)
- [Product 2]: [affiliate URL] (compared/mentioned)
...

Next Steps:
- Personalize: Add your own experience, screenshots, and results
- Images: Take product screenshots and add them at suggested locations
- Links: Replace affiliate URLs with your own tracking links
- Publish: See references/wordpress-deploy.md for WordPress setup guide
- Promote: Run viral-post-writer to create social posts promoting this article
---
```

### Step 5: Self-Validation

Before presenting output, verify:

- [ ] Word count meets format target (review: 2-3.5K, comparison: 2.5-3.5K, listicle: 3-5K, how-to: 2-3K)
- [ ] FTC disclosure near top of article, medium format
- [ ] 2-4 CTAs placed at: after pricing, feature demo, verdict, optional callout box
- [ ] Meta description is 150-160 characters
- [ ] Target keyword appears naturally in first 100 words
- [ ] No placeholder text, no AI-generated disclaimers

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
article:
  title: string # SEO-optimized title
  slug: string # URL-friendly slug
  meta_description: string # 150-160 character meta description
  target_keyword: string # Primary keyword targeted
  format: string # review | comparison | listicle | how-to
  content: string # Full markdown article
  word_count: number # Actual word count
  headings: # Article structure
    - level: number # 2 for H2, 3 for H3
      text: string # Heading text

seo:
  secondary_keywords: string[] # 3-5 secondary keywords used
  faq_questions: # For FAQ schema markup
    - question: string
      answer: string
  image_suggestions: # Recommended images
    - description: string # What to screenshot/create
      alt_text: string # SEO alt text
      placement: string # After which section

products_featured: # All products mentioned
  - name: string
    url: string # Affiliate URL
    role: string # "primary" | "compared" | "mentioned"
    reward_value: string # Commission info
    pricing: string | null # Starting price (e.g., "$49/mo") — for S4 landing page chaining
```

## Output Format

Present the output as a single markdown document with three clearly separated sections:

1. **SEO Metadata** — fenced block with all SEO settings for easy copy into WordPress/Yoast
2. **Article** — the full blog post in markdown, ready to paste
3. **Supplementary** — FAQ for schema markup, image suggestions, products list, and next steps

The article should be **immediately publishable** — not a draft or outline. The user should be able to copy-paste it into their blog editor, add their own screenshots and personal touches, and publish.

## Error Handling

- **No product provided**: "I need a product to write about. Run `/affiliate-program-search` first to find one, or tell me the product name and I'll research it."
- **Comparison with only 1 product**: Auto-search for 2-3 competitors using `web_search`. Search: `"best alternatives to [product]"` on G2/Capterra.
- **No compare_with for listicle**: Auto-search for 4-6 products in the category. Inform user: "I found these products to include — let me know if you want to swap any."
- **Unknown blog platform**: Default to markdown output. Add note: "This is universal markdown — works with WordPress, Ghost, Hugo, Astro, and most platforms."
- **Product has no public info**: Use `web_search` to research the product. If still insufficient: "I couldn't find enough information about [product] to write a credible article. Can you provide more details about features, pricing, and your experience?"
- **Controversial or questionable product**: Include balanced pros/cons. Add note: "This product has mixed reviews — make sure you've personally verified these claims before publishing."

## Examples

### Example 1: Product Review (chained from S1)

**User**: "Now write a detailed review of HeyGen for my blog"
**Context**: S1 previously returned HeyGen as recommended_program
**Action**: Auto-detect format=review, pick up HeyGen product data from S1 output, generate full review article targeting "heygen review" keyword.

### Example 2: Comparison Article

**User**: "Write a comparison blog post: HeyGen vs Synthesia vs Colossyan for AI video creation"
**Action**: Format=comparison, primary product=HeyGen (if from S1, else first mentioned), compare_with=[Synthesia, Colossyan], target keyword="heygen vs synthesia vs colossyan".

### Example 3: Listicle (Default Format)

**User**: "Write a blog post about the best AI video tools"
**Action**: Format=listicle (matches "best"), web_search for top AI video tools, target keyword="best ai video tools", write 3-5K word roundup with 5-7 products.

### Example 4: How-To Guide

**User**: "Write a tutorial blog post on how to create AI-generated videos for YouTube with HeyGen"
**Action**: Format=how-to (matches "tutorial", "how to"), target keyword="how to create ai videos for youtube", write step-by-step guide featuring HeyGen with affiliate CTAs.

### Example 5: Minimal Input

**User**: "Blog post about Semrush"
**Action**: No format specified → default to listicle? No — single product implies review. Use format=review, web_search Semrush for features/pricing/reviews, target keyword="semrush review", generate full article.

**Format detection logic for ambiguous cases**: If only one product is mentioned with no format keyword, default to `review`. If a category is mentioned with no specific product, default to `listicle`.

## References

- `references/seo-checklist.md` — Title formulas, meta description rules, heading hierarchy, keyword density, content depth guidelines. Read in Step 2.
- `references/blog-templates.md` — Four article format templates (review, comparison, listicle, how-to) with exact structure. Read in Step 3.
- `references/wordpress-deploy.md` — WordPress publishing guide, Yoast SEO setup, Pretty Links, FAQ schema implementation. Reference in Step 4 next steps.
- `shared/references/ftc-compliance.md` — FTC disclosure requirements and format templates. Read in Step 3 for disclosure text.
- `shared/references/affitor-branding.md` — Affitor brand guidelines. Note: NO Affitor branding in article body (user's blog). Only in tool output metadata.
- `shared/references/affiliate-glossary.md` — Affiliate marketing terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `landing-page-creator` (S4) — `products_featured` for comparison landing pages
- `content-pillar-atomizer` (S2) — blog article as pillar content to atomize into social
- `bonus-stack-builder` (S4) — products featured inform bonus design
- `internal-linking-optimizer` (S6) — new article needs internal links within 48 hours

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `keyword-cluster-architect` (S3) — target keywords and cluster topics
- `proprietary-data-generator` (S7) — unique data for differentiated articles
- `internal-linking-optimizer` (S6) — link suggestions for existing articles
- `content-decay-detector` (S3) — refresh instructions for decaying articles

### Feedback Loop

- `seo-audit` (S6) and `performance-report` (S6) track article rankings and traffic → identify which article formats and topics perform best → optimize content strategy

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
  skill_slug: "affiliate-blog-builder"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "content-pillar-atomizer"
    - "landing-page-creator"
    - "internal-linking-optimizer"
    - "seo-audit"
```
