---
name: squeeze-page-builder
description: >
  Build email capture landing pages (squeeze pages) as single self-contained HTML files.
  Triggers on: "build a squeeze page", "email capture page", "lead magnet page",
  "create an opt-in page", "build an email list page", "lead capture landing page",
  "create a freebie page", "build a page to collect emails", "opt-in landing page",
  "email signup page for [product/niche]", "create a lead magnet landing page",
  "build a page that captures emails before sending to affiliate offer".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "landing-pages",
    "conversion",
    "offers",
    "lead-generation",
    "squeeze-page",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Squeeze Page Builder

Build email capture landing pages (squeeze pages) as self-contained HTML files with no dependencies. The page offers a high-value lead magnet (ebook, checklist, template, or cheat sheet) in exchange for the visitor's email address, then redirects to an affiliate offer on form submission. Output is a single deployable `.html` file.

## When to Use

- User wants to build an email list while simultaneously promoting an affiliate product
- User wants to warm up cold traffic before sending to an affiliate offer
- User says "squeeze page", "opt-in page", "lead magnet", "email capture", "freebie page"
- User wants a two-step funnel: email capture → affiliate redirect
- User has ad traffic and needs a landing page that collects leads before the affiliate click

## Workflow

### Step 1: Define the Lead Magnet and Offer

A squeeze page requires two things:

1. **The lead magnet** — the free thing offered in exchange for the email
2. **The thank-you redirect** — where the visitor goes after submitting (the affiliate link)

**Detect from user input. If not specified, ask:**

- "What free resource will you offer? (e.g., a checklist, ebook, template, cheat sheet, mini-course)"
- "What affiliate product should visitors see after they sign up?"

**Lead magnet selection guide** — suggest based on niche if user is unsure:
| Niche | Best lead magnet type |
|---|---|
| Marketing / SEO | Checklist, swipe file, templates |
| Finance / Investing | Calculator, cheat sheet, guide |
| Health / Fitness | Meal plan, workout plan, tracker |
| Software / SaaS | Tutorial, quick-start guide, resource list |
| Business / Productivity | Templates, SOPs, spreadsheets |

**Lead magnet title formula** (high-converting):

- "[N]-Point Checklist: How to [Achieve Desired Outcome]"
- "The Free [Niche] Starter Kit: [X] Templates for [Goal]"
- "Download: The Ultimate [Topic] Guide ([Year])"
- "[Adjective] Cheat Sheet: [X] Ways to [Outcome] in [Timeframe]"

### Step 2: Craft the Page Strategy

Read `references/conversion-principles.md` for squeeze page-specific principles.

Key conversion levers for squeeze pages:

1. **Clarity over cleverness** — the visitor should know in 3 seconds what they get and what they must do
2. **Above-fold completeness** — the opt-in form must be visible without scrolling on mobile
3. **Single goal** — no navigation, no external links, no distractions
4. **Social proof** — even one strong number ("Join 4,200+ marketers") dramatically lifts conversion
5. **Privacy signal** — "No spam. Unsubscribe anytime." reduces friction at the form

Plan the page sections:

1. **Header** — logo/brand name only (no nav links)
2. **Hero section** (above fold):
   - Headline: the transformation or outcome the lead magnet delivers
   - Sub-headline: what's inside + who it's for
   - Lead magnet visual (styled HTML mockup — no images needed)
   - Email form with single field + submit button
   - Privacy micro-copy: "No spam. Unsubscribe anytime."
3. **What's Inside** — 3-5 bullet points describing lead magnet contents
4. **Social Proof** — subscriber count, testimonial, or press mention
5. **Who This Is For** — 3-4 bullet points identifying the ideal reader
6. **Second opt-in form** — repeat the form lower on the page for scrollers
7. **Footer** — FTC note, privacy policy placeholder, Affitor attribution

**Thank-you redirect behavior:**
The form submission should redirect to the affiliate URL. Since this is a static HTML file with no backend, use a JavaScript pattern:

```javascript
form.addEventListener("submit", function (e) {
  e.preventDefault();
  // In production: POST email to your ESP (Mailchimp, ConvertKit, etc.)
  // Then redirect to affiliate offer:
  window.location.href = "[affiliate_url]";
});
```

Include a comment block explaining how to wire this to a real ESP (Mailchimp embed code, ConvertKit, etc.).

### Step 3: Write the Full HTML

Build a complete, self-contained HTML file:

**Copy requirements:**

Headline (8-12 words, result-focused):

- "Get the Free [Lead Magnet Title] and Start [Outcome] Today"
- "Download: [Lead Magnet Title] — Free for [Audience]"
- "The [Adjective] Way to [Outcome]: Free [Format] Inside"

Sub-headline (15-25 words):

- "[N] [templates/steps/strategies] that [specific audience] use to [specific outcome] — completely free."

Button copy (action-oriented, not "Submit"):

- "Send Me the Free [Lead Magnet] →"
- "Get Instant Access →"
- "Download the Free [Format] Now →"

**HTML structure requirements:**

- Single `<style>` block — no external CSS
- Mobile-first responsive (375px base, 768px breakpoint)
- System font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- Color scheme from user input or default: primary `#2563eb`, accent warm tone
- Lead magnet mockup: a styled `<div>` that looks like a book/checklist cover — pure CSS, no images
- Form: single email input + submit button (no name field — lower friction)
- No navigation links that could take the visitor off the page
- `<meta name="robots" content="noindex">` — squeeze pages shouldn't be indexed by Google

**JavaScript:**

- Form validation (email format check)
- Redirect to affiliate URL on submit
- Comment block with ESP integration instructions for Mailchimp, ConvertKit, Kit, and Beehiiv

**Required elements:**

- FTC disclosure in footer: "This page contains affiliate links. If you purchase through our links, we may earn a commission."
- Privacy micro-copy on form: "No spam. Unsubscribe anytime."
- "Built with Affiliate Skills by Affitor" footer — use exact HTML from `shared/references/affitor-branding.md`

### Step 4: Format Output

**Part 1: Page Summary**

```
---
SQUEEZE PAGE
---
Lead Magnet: [title of the free offer]
Affiliate Redirect: [product name] — [affiliate URL]
Headline: [the main headline used]
Button Copy: [CTA button text]
Color Scheme: [color applied]
ESP Integration: Instructions included in HTML comments
---
```

**Part 2: Complete HTML**
Full self-contained HTML in a fenced code block. Save as `[niche]-optin.html`.

**Part 3: Setup Instructions**

```
---
SETUP
---
1. Save as `[niche]-optin.html` — open in browser to preview
2. Wire the form to your ESP:
   - Mailchimp: Replace the JS redirect with your Mailchimp embed form action URL
   - ConvertKit/Kit: Use their API or embed form, keep the redirect in the success hook
   - Beehiiv: Use their embed form with a custom redirect
3. Replace affiliate URL: search for "[AFFILIATE_URL]" in the file — update with your tracking link
4. Deploy: Netlify Drop (drag to app.netlify.com/drop), GitHub Pages, or any static host
5. Drive traffic: Use social posts, paid ads, or bio link to send visitors to this page
---
```

## Input Schema

```yaml
lead_magnet:                # REQUIRED
  title: string             # e.g., "The 10-Point SEO Audit Checklist"
  type: string              # "checklist" | "ebook" | "template" | "cheat-sheet" | "mini-course" | "resource-list"
  description: string       # What's inside — used for bullet points

affiliate_product:          # REQUIRED — where to redirect after email capture
  name: string
  url: string               # Affiliate link — the thank-you redirect destination
  reward_value: string
  description: string       # Brief — used in footer context if needed

target_audience: string     # REQUIRED — who this page is for (e.g., "e-commerce store owners")

niche: string               # OPTIONAL — helps with copy tone and lead magnet visual styling
                            # e.g., "marketing", "finance", "fitness", "SaaS"

headline: string            # OPTIONAL — override auto-generated headline

color_scheme: string        # OPTIONAL — "blue" | "green" | "purple" | "orange" | "dark" | hex
                            # Default: "blue" (#2563eb)

social_proof: object        # OPTIONAL — subscriber count or testimonial
  type: string              # "count" | "testimonial"
  value: string             # "4,200+ subscribers" OR a short quote
  attribution: string       # If testimonial: "— Name, Job Title"

esp: string                 # OPTIONAL — which email service provider they use
                            # "mailchimp" | "convertkit" | "beehiiv" | "aweber" | "other"
                            # Default: "other" (generic instructions)
```

### Step 5: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure in footer
- [ ] Privacy micro-copy near form: "No spam. Unsubscribe anytime."
- [ ] `<meta name="robots" content="noindex">` present
- [ ] Form has single email field only (no name field — lower friction)
- [ ] Form validates email format before submission
- [ ] Self-contained HTML: no external resources, no navigation links off-page

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
squeeze_page:
  lead_magnet_title: string
  headline: string
  button_copy: string
  affiliate_redirect: string # The affiliate URL used in the redirect
  color_scheme: string
  html: string # Complete self-contained HTML
  filename: string # e.g., "seo-checklist-optin.html"

funnel:
  step_1: string # "Visitor sees squeeze page"
  step_2: string # "Visitor submits email"
  step_3: string # "Visitor redirected to [product] affiliate page"
  esp_note: string # Note about wiring to an ESP

deploy:
  local: string
  netlify: string
  github_pages: string
```

## Output Format

Present as three sections:

1. **Page Summary** — lead magnet, redirect target, headline used
2. **HTML** — complete file in a code block, ready to save and deploy
3. **Setup Instructions** — how to wire ESP and deploy

The HTML should work as a preview without any backend — form submission redirects to affiliate URL directly in the demo state.

## Error Handling

- **No lead magnet specified**: Suggest 3 options based on the niche. Ask: "Which type of lead magnet would you like? Here are 3 ideas for [niche]: [A], [B], [C]."
- **No affiliate URL**: "What affiliate product should visitors see after they sign up? This is the thank-you redirect destination."
- **Audience too vague**: Use the niche to infer audience. If still unclear, use "online entrepreneurs and marketers" as the default.
- **No ESP specified**: Include generic ESP instructions in comments covering Mailchimp, ConvertKit, and Beehiiv.
- **User wants form to actually send emails**: Explain that static HTML cannot send emails directly. Provide instructions for using Netlify Forms or Formspree as a free no-backend option.

## Examples

**Example 1: SEO checklist**
User: "Build a squeeze page offering a free SEO checklist, send people to my Semrush affiliate link after"
Action: lead_magnet={title:"10-Point SEO Audit Checklist", type:"checklist"}, affiliate_redirect=Semrush URL, generate page with checklist mockup visual, blue theme.

**Example 2: Custom headline and color**
User: "Create an email capture page for a free email marketing template pack, purple color scheme, redirect to Klaviyo"
Action: lead_magnet="Email Marketing Template Pack", color_scheme=purple, affiliate_redirect=Klaviyo, generate page.

**Example 3: With social proof**
User: "Squeeze page for a free AI tools cheat sheet with 2000 subscribers social proof"
Action: lead_magnet="AI Tools Cheat Sheet", social_proof={type:"count", value:"2,000+ subscribers"}, generate page with subscriber count displayed prominently.

**Example 4: Chained from S1**
User: "Build a squeeze page to warm up leads before sending them to this offer"
Context: S1 returned HeyGen as recommended_program
Action: affiliate_product=HeyGen from S1, suggest 3 lead magnet ideas for the AI video niche, build squeeze page on selection.

## References

- `references/conversion-principles.md` — Squeeze page conversion principles, above-fold rules, form optimization. Read in Step 2.
- `shared/references/ftc-compliance.md` — FTC footer text. Read in Step 3.
- `shared/references/affitor-branding.md` — Footer attribution HTML. Read in Step 3.
- `shared/references/affiliate-glossary.md` — Terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `email-drip-sequence` (S5) — captured emails enter drip sequence
- `bio-link-deployer` (S5) — squeeze page URL for link hub
- `github-pages-deployer` (S5) — HTML file to deploy

### Fed By

- `affiliate-program-search` (S1) — product for the redirect after opt-in
- `value-ladder-architect` (S4) — squeeze page specs for Rung 0/1 of the ladder
- `bonus-stack-builder` (S4) — lead magnet/bonus as the opt-in incentive

### Feedback Loop

- `conversion-tracker` (S6) measures opt-in rate → optimize headline, form placement, lead magnet offer

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
  skill_slug: "squeeze-page-builder"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "email-drip-sequence"
    - "bio-link-deployer"
    - "conversion-tracker"
```
