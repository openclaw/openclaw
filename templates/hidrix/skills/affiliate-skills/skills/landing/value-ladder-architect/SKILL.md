---
name: value-ladder-architect
description: >
  Design the complete free-to-premium value ladder for affiliate promotions.
  Triggers on: "value ladder", "customer journey", "upsell path", "ascension model",
  "free to paid funnel", "tripwire offer", "upsell strategy", "downsell",
  "product ladder", "price ladder", "customer ascension", "funnel architecture",
  "map my funnel", "design my funnel stages", "monetization path".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "landing-pages", "conversion", "offers", "value-ladder", "pricing"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Value Ladder Architect

Design the complete free → tripwire → core → upsell path for affiliate promotions. Maps the entire customer ascension journey, where each step delivers standalone value while naturally leading to the next. The value ladder IS the page sequence: squeeze → bridge → sales → upsell.

## Stage

S4: Landing — The value ladder defines the sequence of pages and offers. Each rung is a landing page, email, or content piece that converts the visitor to the next level.

## When to Use

- User wants to map the entire customer journey, not just one landing page
- User asks about upsells, downsells, tripwires, or funnel stages
- User wants to maximize lifetime value from affiliate promotions
- User says "value ladder", "customer journey", "ascension", "funnel architecture"
- After running `grand-slam-offer` to design the core offer and wanting to expand
- User promotes a product with multiple tiers (free, pro, enterprise)

## Input Schema

```yaml
product:                      # REQUIRED
  name: string                # Product name
  pricing_tiers: object[]     # Available pricing tiers
    - name: string            # e.g., "Free", "Pro", "Enterprise"
      price: string           # e.g., "$0", "$49/mo", "$199/mo"
      features: string[]      # Key features at this tier
  reward_value: string        # Your commission
  reward_type: string         # "recurring" | "one-time" | "tiered"
  url: string                 # Affiliate link

your_assets: string[]         # OPTIONAL — content/resources you already have
                              # e.g., ["blog", "email list", "YouTube channel", "templates"]
                              # Default: ["blog"]

goal: string                  # OPTIONAL — "first_commission" | "maximize_ltv" | "build_list"
                              # Default: "first_commission"
```

**Chaining from S4 grand-slam-offer**: Use `offer_stack` to position the core offer in the ladder.
**Chaining from S4 bonus-stack-builder**: Use `bonus_stack` to populate tripwire and bonus tiers.

## Workflow

### Step 1: Gather Context

1. Map the product's pricing tiers and commission structure
2. Identify user's existing assets (blog, list, social following)
3. Determine goal: first commission (simple ladder) vs maximize LTV (complex ladder)

### Step 2: Design the Ladder

Read `shared/references/offer-frameworks.md` for the Value Ladder framework.

Map each rung:

**Rung 0: FREE (Awareness)**

- What: Blog post, social content, free tool, lead magnet
- Goal: Build trust, capture email, demonstrate expertise
- Skills used: S2 Content, S3 Blog
- Conversion to next rung: Lead magnet opt-in or email capture

**Rung 1: TRIPWIRE ($1-$49, impulse buy)**

- What: Your low-cost asset (template pack, mini-course, audit)
- Goal: Convert from reader to buyer, get email if not captured
- Skills used: `bonus-stack-builder` for asset ideas, `squeeze-page-builder` for page
- Conversion to next rung: Email sequence recommending the core product

**Rung 2: CORE (main affiliate product)**

- What: The affiliate product at its most popular tier
- Goal: Primary commission — solve their main problem
- Skills used: `grand-slam-offer`, `landing-page-creator`
- Conversion to next rung: Product usage → ready for premium tier

**Rung 3: UPSELL (premium tier or complementary product)**

- What: Higher tier of same product, or complementary affiliate product
- Goal: Maximize lifetime value, earn larger commission
- Skills used: `landing-page-creator` (comparison), `email-drip-sequence`
- Conversion: Ongoing value through content → repeat customer

### Step 3: Map the Page Sequence

For each rung, specify:

- Page type (blog post, squeeze page, bridge page, landing page, email)
- Traffic source (organic, social, email, paid)
- Affiliate skill to build it
- Conversion mechanism (CTA, email opt-in, checkout)
- Expected conversion rate benchmark

### Step 4: Design Transition Triggers

Define what moves a person from one rung to the next:

- Rung 0→1: Downloaded lead magnet → email sequence pitching tripwire
- Rung 1→2: Purchased tripwire → immediate upsell page OR email sequence
- Rung 2→3: Used product for X days → email about premium features

### Step 5: Output

Present the complete value ladder with implementation roadmap.

### Step 6: Self-Validation

- [ ] Each rung delivers standalone value (P4 principle)
- [ ] Transitions feel natural, not forced
- [ ] The affiliate product is the CORE (Rung 2), not the upsell
- [ ] Free content (Rung 0) is genuinely helpful, not just a teaser
- [ ] Implementation order is realistic (start simple, add rungs over time)
- [ ] FTC disclosure at every rung with affiliate links

## Output Schema

```yaml
output_schema_version: "1.0.0"
value_ladder:
  product_name: string
  total_rungs: number
  rungs:
    - level: number # 0, 1, 2, 3
      name: string # "Free", "Tripwire", "Core", "Upsell"
      offer: string # What they get
      price: string # Price point
      page_type: string # "blog" | "squeeze" | "bridge" | "landing" | "email"
      skill_to_build: string # Which affiliate skill creates this page
      conversion_to_next: string # How they move to next rung
      estimated_conversion: string # Benchmark conversion rate

  implementation_order: string[] # Which rungs to build first
  email_sequences: object[] # Email sequences connecting rungs

chain_metadata:
  skill_slug: "value-ladder-architect"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "squeeze-page-builder"
    - "landing-page-creator"
    - "email-drip-sequence"
    - "funnel-planner"
```

## Output Format

```
## Value Ladder: [Product Name]

### Ladder Overview
```

[Visual ladder diagram using ASCII]

```

### Rung 0: FREE — [Offer Name]
- **What:** [specific content/resource]
- **Where:** [blog post / social / lead magnet]
- **Traffic:** [organic / social / paid]
- **Build with:** [skill name]
- **→ Next:** [transition trigger to Rung 1]
- **Benchmark:** [expected conversion %]

### Rung 1: TRIPWIRE — [Offer Name] ($XX)
[same structure]

### Rung 2: CORE — [Product Name] ($XX/mo)
[same structure]

### Rung 3: UPSELL — [Offer Name] ($XX/mo)
[same structure]

### Implementation Roadmap
1. **Week 1:** Build Rung 2 (core landing page) — start earning immediately
2. **Week 2:** Build Rung 0 (blog content driving traffic)
3. **Week 3:** Build Rung 1 (tripwire to capture emails)
4. **Week 4+:** Build Rung 3 (upsell for max LTV)

### Email Sequences
- **Rung 0→1:** [X emails over Y days] — [theme]
- **Rung 1→2:** [X emails over Y days] — [theme]
- **Rung 2→3:** [X emails over Y days] — [theme]
```

## Error Handling

- **No product provided**: "I need a product to design a value ladder for. Run `affiliate-program-search` or tell me the product."
- **Product has only one pricing tier**: Design ladder with Rung 0 (free content), Rung 1 (your tripwire), Rung 2 (the product). Note complementary products for Rung 3.
- **User has no existing assets**: Start with Rung 2 only (direct landing page). Build Rung 0 and 1 over time. "Start earning first, then build the ladder."
- **Product is one-time payment**: Focus ladder on complementary recurring products for Rung 3 to build ongoing income.

## Examples

**Example 1:** "Design a value ladder for HeyGen"
→ Free: "AI Video for Business" blog series → Tripwire: $7 "50 AI Video Script Templates" → Core: HeyGen Pro ($48/mo, 30% recurring) → Upsell: HeyGen Enterprise + your premium implementation package.

**Example 2:** "I have a blog and email list, design my Semrush funnel"
→ Free: SEO tutorial blog posts → Tripwire: $19 "Complete SEO Audit Template Kit" → Core: Semrush Pro ($129/mo, $200 bounty) → Upsell: Semrush Business + monthly SEO coaching.

**Example 3:** "Map my funnel" (after grand-slam-offer + bonus-stack)
→ Pick up offer and bonuses from chain context. Place bonuses as tripwire (Rung 1), core offer as Rung 2, design complementary upsell for Rung 3.

## Flywheel Connections

### Feeds Into

- `squeeze-page-builder` (S4) — Rung 0/1 page specs
- `landing-page-creator` (S4) — Rung 2/3 page specs
- `email-drip-sequence` (S5) — transition email sequences between rungs
- `funnel-planner` (S8) — value ladder informs the week-by-week execution plan

### Fed By

- `grand-slam-offer` (S4) — core offer positioning for Rung 2
- `bonus-stack-builder` (S4) — bonuses for tripwire and core rungs
- `affiliate-program-search` (S1) — product and pricing data

### Feedback Loop

- `conversion-tracker` (S6) measures conversion rates between rungs → identify bottleneck rungs and optimize

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (each rung feels like a natural step)

Any NO → rewrite before delivering.

## References

- `shared/references/offer-frameworks.md` — Value Ladder framework, pricing psychology
- `shared/references/ftc-compliance.md` — FTC disclosure at every rung
- `shared/references/affiliate-glossary.md` — Terminology
- `shared/references/flywheel-connections.md` — Master connection map
