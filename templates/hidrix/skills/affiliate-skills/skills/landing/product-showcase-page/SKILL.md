---
name: product-showcase-page
description: >
  Build a single-product deep-dive showcase page as a self-contained HTML file.
  Triggers on: "build a product showcase page", "deep dive landing page for [product]",
  "create a product spotlight page", "product feature page", "single product page",
  "detailed page about [product]", "build a page showing everything about [product]",
  "create a long-form product page", "build a sales page for [product]",
  "product deep dive page", "make a feature breakdown page for [product]".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "landing-pages", "conversion", "offers", "showcase", "product-page"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Product Showcase Page

Build a long-form, single-product showcase page as a self-contained HTML file. Goes deeper than a standard landing page — includes a full hero section, feature breakdown with icons, use case demonstrations, testimonials, a pricing comparison table, FAQ with accordions, and multiple high-intent affiliate CTAs. Designed for pre-sold traffic (readers who came from a review or comparison) and wants to make the final conversion push.

## When to Use

- User wants a dedicated page for one product that covers everything a buyer needs to know
- User says "showcase page", "product spotlight", "deep-dive page", "feature breakdown page"
- User wants a page longer than a standard landing page — for high-ticket products needing more persuasion
- User is sending warm traffic (from a blog post or email) and wants to close the sale
- User wants a page that can double as a product review in page form

## Workflow

### Step 1: Gather Product Data

If `product` data is available from S1 or prior conversation, use it directly.

Otherwise, use `web_search` to research the product:

1. **Features**: `"[product name] features"` — gather 6-12 distinct capabilities
2. **Pricing**: `"[product name] pricing"` — all tiers with feature differences
3. **Use cases**: `"[product name] use cases"` OR `"[product name] examples"` — concrete applications
4. **Testimonials**: `"[product name] reviews"` on G2/Capterra — find real sentiment (do not copy verbatim — paraphrase or create realistic representative examples)
5. **Competitors**: `"[product name] vs"` — 2-3 competitors for the pricing comparison
6. **FAQ**: `"[product name] questions"` OR check product's own FAQ page

Organize the research into these buckets:

- Core features (6-12, each with a one-sentence benefit statement)
- Use cases (3-5, each framed as a specific problem solved)
- Pricing tiers (2-4 tiers with included features and price)
- Comparison data (the 5-8 dimensions where this product wins vs. competitors)
- Social proof (ratings, user counts, company names using it)
- FAQ answers (6-10 questions)

### Step 2: Plan the Page Architecture

Read `references/conversion-principles.md` for long-form page principles.

A product showcase page is longer than a standard landing page — it must justify the length with value at every section. Plan each section:

1. **FTC Disclosure** — small, above hero
2. **Hero** — headline + sub-headline + primary CTA + hero visual + trust bar
3. **Problem Statement** — 2-3 sentences establishing the pain the product solves
4. **Product Overview** — 3-sentence description + key stats
5. **Features Grid** — 6-12 features with icons (pure CSS) + headline + description
6. **Use Cases** — 3-5 real scenarios (who uses it, how, outcome)
7. **Social Proof Bar** — logos, ratings, subscriber counts
8. **Pricing Comparison** — table comparing this product's tiers against 2 competitors
9. **Testimonials** — 2-3 cards with quote, name, role
10. **FAQ Accordion** — 6-10 questions with JS-powered expand/collapse
11. **Final CTA Section** — strong headline + benefits recap + primary CTA button
12. **Footer** — FTC disclosure full text, Affitor attribution

**CTA placement rules:**

- Hero: primary CTA (always visible)
- After Features Grid: secondary CTA
- After Pricing Table: high-intent CTA (primed by seeing pricing)
- After Testimonials: social-proof-backed CTA
- Final CTA section: closing CTA
- Total: 4-5 CTAs per page

**Angle selection** — choose based on what the research shows:
| Angle | Headline formula |
|---|---|
| Best in category | "The [Category] Tool That Actually Works" |
| Price/value | "Get [Competitor]-Level Results for Half the Price" |
| Speed | "From Zero to [Outcome] in [Timeframe]" |
| Simplicity | "The [Category] Tool That Doesn't Require a Manual" |
| Results-focused | "[Specific Outcome]: How [Product] Delivers Where Others Don't" |

### Step 3: Write the Full HTML

Build a complete self-contained HTML file. This page is longer than standard (~150-200 lines of HTML) and should feel like a high-quality product page.

**Design specifications:**

- All CSS inline in a `<style>` block — no external stylesheets
- System font stack — no Google Fonts
- Mobile-first responsive (375px base, 768px, 1024px breakpoints)
- Feature icons: pure CSS geometric shapes or Unicode symbols — no icon libraries
- FAQ accordion: minimal JavaScript for expand/collapse, gracefully degrades without JS
- Color scheme from input or default blue (`#2563eb`) with appropriate complementary tones
- Section alternating backgrounds for visual rhythm (white / light gray / white)

**Copy requirements per section:**

_Hero Headline_ (6-12 words, outcome-focused):

- Avoid: "Welcome to [Product]", "[Product] is the best...", generic superlatives
- Use: specific outcomes, target audience callouts, contrarian angles

_Feature headlines_ (each feature gets a benefit headline, not a feature name):

- Not: "Advanced Reporting Dashboard"
- Yes: "See Exactly What's Working at a Glance"

_Use case structure_ (one per scenario):

```html
<!-- The problem → The solution → The result pattern -->
"[Job title] needed to [task]. With [Product]'s [feature], they [outcome] in [timeframe]."
```

_Pricing table_ (comparison layout):

- Column 1: this product (highlighted as "Recommended")
- Column 2: Competitor A
- Column 3: Competitor B
- Rows: 8-10 comparison features
- Include: "Free trial" row and "Cancel anytime" signal

_Testimonials_ (2-3 cards):
Write realistic representative testimonials if real ones unavailable. Each must have:

- A specific, measurable result ("Saved 6 hours a week", "ROI of 340%")
- Name + job title + company type
- Do NOT use made-up full names and companies — use "[First name], [Job title] at a [company type]" format

_FAQ items_ (6-10):
Cover the real objections:

- Pricing and cancellation questions
- Technical requirements
- Data security / privacy
- How it compares to [main competitor]
- Onboarding time
- Customer support availability

**Required elements:**

- FTC disclosure (small, above hero)
- All affiliate links with `target="_blank" rel="noopener"`
- `<meta name="viewport">` and basic SEO meta tags
- `<meta name="robots" content="noindex">` (product pages are not for organic search)
- "Built with Affiliate Skills by Affitor" footer from `shared/references/affitor-branding.md`

### Step 4: Format Output

**Part 1: Page Summary**

```
---
PRODUCT SHOWCASE PAGE
---
Product: [name]
Angle: [marketing angle used]
Headline: [hero headline]
Sections: [list all sections in order]
CTAs: [count and placement]
Color: [color scheme]
Features covered: [N]
FAQ items: [N]
---
```

**Part 2: Complete HTML**
Full file in a fenced code block. Save as `[product-slug]-showcase.html`.

**Part 3: Deploy Instructions**

```
---
DEPLOY
---
1. Save as `[product-slug]-showcase.html`
2. Preview: open in any browser — no server needed
3. Customize: swap testimonial details, add real screenshots, update pricing
4. Deploy: Netlify Drop / Vercel / GitHub Pages
5. Track: Add UTM parameters to your traffic sources targeting this page
   e.g., ?utm_source=email&utm_medium=newsletter&utm_campaign=[product]
---
```

## Input Schema

```yaml
product:                    # REQUIRED
  name: string
  description: string
  reward_value: string
  url: string               # Affiliate link
  reward_type: string
  cookie_days: number
  tags: string[]

angle: string               # OPTIONAL — marketing angle
                            # "best-in-class" | "price-value" | "speed" | "simplicity" | "results"
                            # Default: auto-detected from product strengths

compare_with: object[]      # OPTIONAL — competitors for pricing comparison table
  - name: string
    pricing: string         # Starting price
    url: string             # Non-affiliate URL

color_scheme: string        # OPTIONAL — "blue" | "green" | "purple" | "orange" | "dark" | hex
                            # Default: "blue"

target_audience: string     # OPTIONAL — specific audience to call out in hero
                            # e.g., "e-commerce store owners", "freelance designers"

social_proof: object        # OPTIONAL — headline social proof signal
  type: string              # "rating" | "user_count" | "company_logos" | "award"
  value: string             # e.g., "4.8/5 on G2", "50,000+ users", "Used by Fortune 500s"

testimonials: object[]      # OPTIONAL — real testimonials to include
  - quote: string
    name: string
    role: string
    result: string          # The specific result they achieved
```

### Step 5: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure present (small format, above hero)
- [ ] `<meta name="robots" content="noindex">` present
- [ ] ≥4 CTAs at: hero, after features, after pricing, after testimonials, final section
- [ ] All affiliate links have `target="_blank" rel="noopener"`
- [ ] Self-contained HTML: icons are CSS/Unicode only, no external resources
- [ ] "Built with Affiliate Skills by Affitor" footer present

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
showcase_page:
  product_name: string
  angle: string
  headline: string
  color_scheme: string
  html: string
  filename: string # e.g., "heygen-showcase.html"
  section_count: number
  cta_count: number
  faq_count: number

products_featured:
  - name: string
    url: string
    role: string # "primary" | "compared"
    cta_count: number

deploy:
  local: string
  netlify: string
  vercel: string
```

## Output Format

Present as three sections:

1. **Page Summary** — product, angle, structure overview, CTA placements
2. **HTML** — complete file in a code block
3. **Deploy Instructions** — preview, customize, deploy steps

The page should be immediately useful as a high-converting standalone URL.

## Error Handling

- **No product provided**: "I need a product to build this showcase for. Run `/affiliate-program-search` first, or tell me the product name and I'll research it."
- **No competitor data for pricing table**: Use `web_search` to find 1-2 competitors. If still unavailable: replace comparison table with single-product pricing tiers table.
- **High-ticket product (>$500/mo)**: Emphasize ROI framing over price framing. Add "Request a Demo" or "Book a Call" CTA alongside the direct sign-up CTA.
- **Product has free plan**: Feature the free plan prominently — it's the main objection handler. Make "Start free, upgrade when ready" a core CTA pattern.
- **Product is B2B enterprise** (no public pricing): Replace pricing table with feature comparison. Use "Get a quote" or "Contact sales" CTA. Note in output.

## Examples

**Example 1: Standard SaaS showcase**
User: "Build a product showcase page for HeyGen"
Action: web_search HeyGen features/pricing/reviews, angle=results-focused ("Create Studio-Quality Videos in Minutes"), blue theme, write full showcase with 12 features, 4 use cases, 3 tiers, 3 testimonials, 8-item FAQ.

**Example 2: With custom angle**
User: "Showcase page for Semrush with a price-value angle vs Ahrefs"
Action: product=Semrush, angle=price-value, compare_with=[Ahrefs, Moz], build pricing comparison table with Semrush as the highlighted winner column.

**Example 3: Dark theme for tech audience**
User: "Product showcase for GitHub Copilot, dark theme, developer audience"
Action: product=GitHub Copilot, color_scheme=dark, target_audience="software developers", feature copy written in technical voice, code snippet examples in use cases section.

**Example 4: Chained from S1**
User: "Create a deep-dive showcase page for this product"
Context: S1 returned Klaviyo as recommended_program
Action: Auto-pick up Klaviyo from S1 output, research features, build full showcase page.

## References

- `references/conversion-principles.md` — Long-form page structure, CTA placement density, trust signal placement. Read in Step 2.
- `shared/references/ftc-compliance.md` — Disclosure text for hero and footer. Read in Step 3.
- `shared/references/affitor-branding.md` — Footer attribution HTML. Read in Step 3.
- `shared/references/affiliate-glossary.md` — Terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `bio-link-deployer` (S5) — showcase page URL for link hub
- `email-drip-sequence` (S5) — showcase page as email destination
- `github-pages-deployer` (S5) — HTML file to deploy

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `grand-slam-offer` (S4) — offer framing for the showcase
- `bonus-stack-builder` (S4) — bonuses to feature on the page

### Feedback Loop

- `conversion-tracker` (S6) measures showcase conversion rate → optimize page elements

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
  skill_slug: "product-showcase-page"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "bio-link-deployer"
    - "github-pages-deployer"
    - "conversion-tracker"
```
