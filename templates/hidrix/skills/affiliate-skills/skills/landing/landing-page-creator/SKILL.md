---
name: landing-page-creator
description: >
  Build high-converting affiliate landing pages as single self-contained HTML files.
  Triggers on: "create a landing page for", "build a landing page", "product landing page",
  "affiliate landing page", "comparison page for", "vs page", "single product page",
  "conversion page", "sales page for affiliate", "landing page HTML", "build me a page for",
  "create a page to promote [product]", "I need a landing page", "make a page for [product]".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "landing-pages", "conversion", "offers", "html", "tailwind"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Landing Page Creator

Build dedicated affiliate landing pages that convert. Output is a single self-contained HTML file with inline CSS — no build step, no dependencies, mobile-responsive, deployable anywhere. Supports two page types: single product spotlight and multi-product comparison.

## Stage

S4: Landing — Higher conversion than blog links because the entire page is designed around one goal: convert a visitor into a click. Landing pages are the bridge between traffic sources (social, email, ads) and the affiliate product.

## When to Use

- User wants a dedicated page to promote an affiliate product
- User wants a comparison/vs page for 2-3 competing products
- User has a product from S1 (affiliate-program-search) and needs a conversion page
- User says anything like "landing page", "sales page", "product page", "comparison page", "vs page"
- User wants to promote an affiliate product beyond blog content
- User needs a deployable HTML page for an affiliate campaign

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

page_type: string           # OPTIONAL — "single" | "comparison"
                            # Default: "single"

compare_with: object[]      # OPTIONAL — products for comparison page
  - name: string            # Competitor name
    description: string     # Brief description
    url: string             # URL (non-affiliate OK)
    pricing: string         # Starting price

angle: string               # OPTIONAL — marketing angle / hook
                            # e.g., "fastest", "cheapest", "best for beginners"
                            # Default: auto-generated from product strengths

color_scheme: string        # OPTIONAL — "blue" | "green" | "purple" | "orange" | "dark" | hex code
                            # Default: "blue" (#2563eb)
```

**Chaining from S1**: If `affiliate-program-search` was run earlier in the conversation, automatically pick up `recommended_program` from its output as the `product` input. The field mapping:

- `recommended_program.name` → `product.name`
- `recommended_program.description` → `product.description`
- `recommended_program.reward_value` → `product.reward_value`
- `recommended_program.url` → `product.url`
- `recommended_program.reward_type` → `product.reward_type`
- `recommended_program.cookie_days` → `product.cookie_days`
- `recommended_program.tags` → `product.tags`

**Chaining from S3**: If `affiliate-blog-builder` was run, use `products_featured` for the comparison page's `compare_with` list.

If the user says "now make a landing page for it" after running S1 — use the recommended program. No need to ask again.

## Workflow

### Step 1: Gather Product Info

If `product` data is available from S1 chaining or user input, use it directly. Otherwise:

1. Use `web_search` to research the product: `"[product name] features pricing review"`
2. Gather: name, description, key features (3-6), pricing, target audience, top competitors
3. If `page_type = comparison` and `compare_with` is empty:
   - Search: `"best alternatives to [product.name]" OR "[product.name] vs"`
   - Find 1-2 competitors with pricing, features, and positioning

### Step 2: Plan Page Structure

Read `references/conversion-principles.md` for AIDA framework, CTA placement, and design rules.

Choose `page_type` if not specified:

- If user mentions "vs", "compare", "comparison", or provides `compare_with` → `comparison`
- Otherwise → `single`

Plan the page sections based on type:

**Single product:**

1. FTC disclosure (above fold)
2. Hero: headline + subtitle + primary CTA + trust signal
3. Trust bar: rating, user count, press mention
4. Features: 3-column grid (3-6 features as benefits)
5. Pricing: price + CTA
6. Testimonial: one strong quote
7. Who is this for: audience list
8. FAQ: 4-6 questions addressing objections
9. Final CTA: headline + CTA button
10. Footer: Affitor branding

**Comparison:**

1. FTC disclosure (above fold)
2. Hero: "[A] vs [B]" headline + subtitle
3. Comparison table: feature rows with winner highlights
4. Individual product sections: description + pros/cons + CTA each
5. Winner callout: clear recommendation with reasoning
6. FAQ: 4-6 comparison-specific questions
7. Dual CTA: buttons for top 2 products
8. Footer: Affitor branding

Map the user's `color_scheme` to CSS custom properties:

- `blue` → `--color-primary: #2563eb`
- `green` → `--color-primary: #059669`
- `purple` → `--color-primary: #7c3aed`
- `orange` → `--color-primary: #ea580c`
- `dark` → `--color-primary: #3b82f6; --color-bg: #0f172a; --color-surface: #1e293b; --color-text: #f1f5f9`
- Hex code → use directly as `--color-primary`

### Step 3: Write Full HTML

Read the matching template from `templates/`:

- `templates/single-product.html` for `page_type = single`
- `templates/comparison.html` for `page_type = comparison`

Use the template as a structural guide. Write a complete HTML file with:

**Content rules:**

- All CSS must be inline (in a `<style>` tag) — no external stylesheets
- No JavaScript dependencies — pure HTML/CSS (JS only for non-essential progressive enhancement like FAQ accordion)
- System font stack — no external font loading
- Mobile-first responsive design (test at 375px width mentally)
- All affiliate links use the user's URL with `target="_blank" rel="noopener"`
- Replace ALL template placeholder content with real product data
- Write compelling copy based on the `angle` — don't be generic

**Required elements:**

- FTC disclosure visible before the first affiliate link — read `shared/references/ftc-compliance.md` and use the **medium** format
- Minimum 3 CTAs distributed through the page (hero, mid-page, bottom)
- "Built with Affiliate Skills by Affitor" footer — read `shared/references/affitor-branding.md` for exact HTML
- `<meta name="viewport">` tag for mobile
- `<title>` and `<meta name="description">` for SEO

**Things to AVOID:**

- No external resources (fonts, images, scripts, stylesheets)
- No placeholder text like "[insert here]" — write complete content
- No fake testimonials — use realistic but clearly example quotes, or omit if unethical
- No navigation menu — this is a landing page, not a website
- No Affitor branding in the page body (only in the footer)

### Step 4: Output

Present the final output in this structure:

**Part 1: Page Summary**

```
---
LANDING PAGE
---
Type: [single/comparison]
Product: [product name]
Angle: [marketing angle used]
Color: [color scheme applied]
CTAs: [number of CTA buttons]
Sections: [list of sections]
---
```

**Part 2: Complete HTML**
The full HTML file in a fenced code block (```html). User can save as `.html` and open in any browser.

**Part 3: Deploy Instructions**

```
---
DEPLOY
---
1. Save the HTML above as `[product-slug]-landing.html`
2. Open locally: double-click the file to preview in your browser
3. Deploy options:
   - Netlify Drop: drag the file to https://app.netlify.com/drop
   - Vercel: `npx vercel deploy --prod` in the file's directory
   - GitHub Pages: push to a repo with GitHub Pages enabled
4. Custom domain: point your domain's DNS to the hosting provider
5. Promote: run `bio-link-deployer` to add this page to your link hub
---
```

### Step 5: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure visible before first affiliate link (medium format)
- [ ] ≥3 CTAs distributed: hero section, mid-page, bottom
- [ ] `<meta name="viewport">` tag present for mobile
- [ ] Self-contained HTML: zero external resources (fonts, images, scripts, stylesheets)
- [ ] "Built with Affiliate Skills by Affitor" footer present
- [ ] No placeholder text like "[insert here]"

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
landing_page:
  type: string # "single" | "comparison"
  product_name: string # Primary product name
  angle: string # Marketing angle used
  color_scheme: string # Color scheme applied
  html: string # Complete self-contained HTML
  filename: string # Suggested filename (e.g., "heygen-landing.html")

products_featured: # All products on the page
  - name: string
    url: string # Affiliate URL
    role: string # "primary" | "compared"
    cta_count: number # Number of CTAs for this product

deploy:
  local: string # "Open [filename] in browser"
  netlify: string # Netlify Drop URL
  vercel: string # Vercel deploy command
  github_pages: string # GitHub Pages instructions
```

## Output Format

Present the output as three clearly separated sections:

1. **Page Summary** — type, product, angle, structure overview
2. **HTML** — the complete file in a code block, ready to save and deploy
3. **Deploy Instructions** — how to get the page live

The HTML should be **immediately deployable** — save it as a `.html` file, open in a browser, and it works. No build step, no dependencies.

## Error Handling

- **No product provided**: "I need a product to create a landing page for. Run `/affiliate-program-search` first to find one, or tell me the product name and I'll research it."
- **Comparison with only 1 product**: Auto-search for 1-2 competitors using `web_search`. Search: `"best alternatives to [product]"`.
- **No pricing info found**: Use `web_search` for `"[product] pricing"`. If still unavailable: include a "Check Current Pricing" CTA instead of a specific price.
- **Unknown color scheme**: Default to blue (`#2563eb`). Inform user: "I used blue as the default. You can pass a hex code like `#ff6600` for a custom color."
- **Product has no public info**: Use `web_search` to research. If insufficient: "I couldn't find enough info about [product] to build a credible landing page. Can you provide features, pricing, and target audience?"

## Examples

### Example 1: Single Product (chained from S1)

**User**: "Create a landing page for HeyGen"
**Context**: S1 previously returned HeyGen as recommended_program
**Action**: Auto-detect page_type=single, pick up HeyGen data from S1, read single-product template, generate complete HTML with blue theme.

### Example 2: Comparison Page

**User**: "Build a comparison page: HeyGen vs Synthesia vs Colossyan"
**Action**: page_type=comparison, primary product=HeyGen (if from S1), compare_with=[Synthesia, Colossyan], web_search for competitor details, generate comparison HTML.

### Example 3: Custom Color

**User**: "Make a dark-themed landing page for Semrush with an SEO angle"
**Action**: page_type=single, color_scheme=dark, angle="SEO", web_search Semrush for features/pricing, generate HTML with dark theme.

### Example 4: Minimal Input

**User**: "Landing page for this product" (after S1)
**Action**: Pick up S1 recommended_program, default page_type=single, default color=blue, auto-generate angle from product strengths.

## References

- `references/conversion-principles.md` — AIDA framework, CTA placement, trust signals, above-fold rules, mobile-first design, color theming. Read in Step 2.
- `templates/single-product.html` — Single product landing page template with all sections. Read in Step 3 for page_type=single.
- `templates/comparison.html` — Multi-product comparison page template. Read in Step 3 for page_type=comparison.
- `shared/references/ftc-compliance.md` — FTC disclosure requirements. Read in Step 3 for disclosure text.
- `shared/references/affitor-branding.md` — Affitor footer HTML. Read in Step 3 for footer.
- `shared/references/affiliate-glossary.md` — Affiliate marketing terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `bio-link-deployer` (S5) — landing page URL for link hub
- `email-drip-sequence` (S5) — landing page as email link destination
- `github-pages-deployer` (S5) — HTML file to deploy
- `conversion-tracker` (S6) — deployed landing page to track

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `affiliate-blog-builder` (S3) — `products_featured` for comparison pages
- `keyword-cluster-architect` (S3) — target keywords for SEO headlines
- `grand-slam-offer` (S4) — offer copy for the page's core messaging
- `bonus-stack-builder` (S4) — bonus details for bonus section
- `guarantee-generator` (S4) — guarantee copy for guarantee section
- `value-ladder-architect` (S4) — page specs for specific ladder rungs

### Feedback Loop

- `conversion-tracker` (S6) measures landing page conversion rate → identify which page elements drive conversions → optimize on next build

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
  skill_slug: "landing-page-creator"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "bio-link-deployer"
    - "github-pages-deployer"
    - "email-drip-sequence"
    - "conversion-tracker"
```
