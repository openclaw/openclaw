---
name: bonus-stack-builder
description: >
  Design exclusive bonus packages that make YOUR affiliate link the obvious choice.
  Triggers on: "create bonuses for", "bonus stack", "what bonuses should I offer",
  "bonus ideas for", "exclusive bonuses", "differentiate my affiliate link",
  "why buy through my link", "affiliate bonuses", "bonus package",
  "what can I offer as a bonus", "design bonuses", "build a bonus stack".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "landing-pages", "conversion", "offers", "bonuses", "hormozi"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Bonus Stack Builder

Design exclusive bonus packages that make YOUR affiliate link the only rational choice. The product is the same through every affiliate's link — your bonuses are what differentiate you. Creates specific, deliverable bonuses matched to your skills and audience needs.

## Stage

S4: Landing — Bonuses live on the landing page. They are the conversion differentiator between your link and every other affiliate promoting the same product.

## When to Use

- User promotes an affiliate product and wants to stand out from other affiliates
- User asks "why would someone buy through MY link?"
- User wants to increase conversion rates on existing promotions
- User says "bonus", "bonus stack", "exclusive offer", "differentiate"
- After running `grand-slam-offer` to flesh out the bonus suggestions

## Input Schema

```yaml
product: # REQUIRED — the affiliate product
  name: string # Product name
  description: string # What it does
  pricing: string # Product price
  url: string # Affiliate link
  tags: string[] # e.g., ["ai", "video", "saas"]

your_skills:
  string[] # OPTIONAL — what you can create/offer
  # e.g., ["writing", "design", "coding", "consulting"]
  # Default: inferred from context

audience_pain_points:
  string[] # OPTIONAL — biggest struggles of your audience
  # Default: inferred from product category

existing_bonuses:
  string[] # OPTIONAL — bonuses you already offer
  # Default: none
```

**Chaining from S4 grand-slam-offer**: If `grand-slam-offer` was run, use `offer_stack.bonuses` as starting point and flesh them out.

## Workflow

### Step 1: Gather Context

1. If product data available from chain, use directly. Otherwise `web_search` for product details.
2. Identify the product's top 3 pain points it solves
3. Identify the product's top 3 gaps (things users struggle with after buying)
4. Research: `"[product] complaints" OR "[product] struggles" OR "[product] learning curve"` to find bonus opportunities

### Step 2: Design Bonus Stack

Read `shared/references/offer-frameworks.md` for bonus types and rules.

For each bonus, define:

1. **What it is** — specific deliverable, not vague
2. **What problem it solves** — maps to a pain point or product gap
3. **Format** — PDF, video, template, spreadsheet, community access, call
4. **Perceived value** — what you'd charge if sold separately
5. **Effort to create** — low/medium/high (helps user prioritize)
6. **Exclusivity** — why this is ONLY available through your link

Design 5-7 bonuses across these tiers:

- **Tier 1: Quick wins** (low effort to create, high perceived value) — templates, checklists, swipe files
- **Tier 2: Deep value** (medium effort, high impact) — mini-course, workshop recording, tool
- **Tier 3: Premium** (high effort, ultimate differentiator) — personal support, community, coaching

### Step 3: Calculate Stack Value

- Sum perceived values of all bonuses
- Compare to product price — bonus value should be 3-10x product price
- Identify the "hero bonus" — the one that does the most persuasive heavy lifting

### Step 4: Write Bonus Copy

For each bonus, write:

- **Name** — specific and benefit-driven (not "Bonus #1")
- **One-liner** — what it is + what it does for them
- **Value statement** — "$XX value — FREE with your purchase"
- **Delivery method** — how they get it after purchasing

### Step 5: Self-Validation

- [ ] Each bonus is specific and deliverable (not vague promises)
- [ ] At least one bonus addresses the product's biggest gap
- [ ] Total bonus value exceeds product price
- [ ] At least one "exclusive" bonus (only through your link)
- [ ] All bonuses are within your skills to actually create
- [ ] No income claims or unrealistic promises

## Output Schema

```yaml
output_schema_version: "1.0.0"
bonus_stack:
  product_name: string
  total_value: string # Total perceived value of all bonuses
  product_price: string # For comparison
  hero_bonus: string # The most compelling bonus name
  bonuses:
    - name: string
      description: string
      problem_solved: string
      format: string # "pdf" | "video" | "template" | "community" | "call" | "tool"
      perceived_value: string
      effort_to_create: string # "low" | "medium" | "high"
      exclusivity: string
      delivery: string # How they receive it

chain_metadata:
  skill_slug: "bonus-stack-builder"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "landing-page-creator"
    - "guarantee-generator"
    - "email-drip-sequence"
```

## Output Format

```
## Bonus Stack: [Product Name]

### Stack Overview
- **Product price:** $XX/mo
- **Total bonus value:** $XXX
- **Hero bonus:** [name]
- **Message:** "Get $XXX in exclusive bonuses FREE when you start [product] through my link"

### Bonus 1: [Name] ($XX value)
**What:** [specific deliverable]
**Solves:** [pain point]
**Format:** [format]
**Delivery:** [how they get it]
**Why exclusive:** [only through your link because...]

[Repeat for each bonus]

### Bonus Copy (ready to paste)

✅ [Bonus 1 name] — [one-liner] ($XX value)
✅ [Bonus 2 name] — [one-liner] ($XX value)
...
**Total value: $XXX — yours FREE through my link**

### Creation Priority
1. [Easiest bonus to create first — get live fast]
2. [Next priority]
3. [Can create later — still mention on page]
```

## Error Handling

- **No product provided**: "I need a product to design bonuses for. Run `affiliate-program-search` first, or tell me the product."
- **No skills specified**: Suggest universal bonuses anyone can create: curated resource lists, setup checklists, comparison spreadsheets, email templates.
- **Product is free tier**: Focus bonuses on accelerating results (templates, guides) rather than adding financial value.
- **User can't deliver high-effort bonuses**: Prioritize Tier 1 (templates, checklists) — they have high perceived value with low creation effort.

## Examples

**Example 1:** "Design bonuses for HeyGen affiliate link"
→ Research HeyGen pain points (avatar creation, script writing, video editing), design bonuses: AI avatar setup guide, 50 video script templates, brand voice cheatsheet, private community access, 1-on-1 setup call.

**Example 2:** "What bonuses can I offer for Semrush? I'm a content writer."
→ Match writer skills to Semrush gaps: keyword research template, content calendar spreadsheet, SEO audit checklist, writing prompts for each content type, monthly strategy call.

**Example 3:** "Create bonuses for this product" (after grand-slam-offer)
→ Take bonus suggestions from grand-slam-offer output, flesh each out with specific deliverables, formats, perceived values, and creation timeline.

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Bonus stacks increase affiliate conversion rates by 2-5x. If your current conversion rate is 1% with 500 monthly clicks = 5 sales × $50 commission = $250/month. With a bonus stack at 3% conversion = 15 sales = $750/month — a $500/month increase from the SAME traffic
- **Benchmark**: Affiliates with bonus stacks report 200-400% higher conversion rates vs naked affiliate links. The hero bonus alone can double conversions
- **Key metric to track**: Conversion rate (sales / clicks) with vs without bonus stack. A/B test by running traffic to both versions for 2 weeks

### Do This Right Now (15 min)

1. Create the **easiest Tier 1 bonus first** — a checklist, template, or swipe file takes 15-30 minutes to make
2. Add the bonus stack copy to your landing page (or create one with `landing-page-creator`)
3. Don't wait until ALL bonuses are ready — launch with 2-3 and add more over time
4. Send an email to your list announcing the exclusive bonuses

### Track Your Results

After 2 weeks: compare conversion rates with and without the bonus stack. If conversion didn't improve, your bonuses don't match the audience's actual pain points — redesign around different pain points.

> **Next step — copy-paste this prompt:**
> "Create a landing page for [product] featuring these bonuses: [list bonuses]" → runs `landing-page-creator`

## Flywheel Connections

### Feeds Into

- `landing-page-creator` (S4) — bonus details populate the bonus section of landing pages
- `guarantee-generator` (S4) — bonus stack informs what to guarantee
- `email-drip-sequence` (S5) — bonus details drive email content
- `squeeze-page-builder` (S4) — bonuses can be the lead magnet

### Fed By

- `grand-slam-offer` (S4) — initial bonus suggestions to flesh out
- `affiliate-program-search` (S1) — product data
- `competitor-spy` (S1) — what competitors' affiliates offer (gaps to exploit)

### Feedback Loop

- `conversion-tracker` (S6) reports which bonus mentions get the most clicks → emphasize those bonuses, redesign underperformers

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (bonuses feel genuinely valuable)

Any NO → rewrite before delivering.

## References

- `shared/references/offer-frameworks.md` — Bonus types, value calculation, stack rules
- `shared/references/ftc-compliance.md` — FTC requirements for bonus claims
- `shared/references/affitor-branding.md` — Branding rules
- `shared/references/flywheel-connections.md` — Master connection map
