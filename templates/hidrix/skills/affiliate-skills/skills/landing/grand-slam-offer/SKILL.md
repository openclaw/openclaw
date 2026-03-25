---
name: grand-slam-offer
description: >
  Design irresistible affiliate offers using the Hormozi Grand Slam framework.
  Triggers on: "create an offer for", "design my offer", "grand slam offer", "make an irresistible offer",
  "why should someone buy through my link", "offer framework", "value proposition for",
  "Hormozi offer", "offer stack", "make my offer irresistible", "craft an offer",
  "what makes my offer different", "offer design", "increase perceived value".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "landing-pages", "conversion", "offers", "hormozi"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Grand Slam Offer

Design affiliate offers so good people feel stupid saying no. Uses the Hormozi Value Equation: **Value = Dream Outcome × Perceived Likelihood ÷ Time Delay ÷ Effort & Sacrifice**. Deconstructs why someone should click YOUR link over any other affiliate's.

## Stage

S4: Landing — The offer IS the landing page's job. Before writing HTML or copy, you need an offer framework that makes the conversion inevitable.

## When to Use

- User wants to differentiate their affiliate promotion from every other affiliate
- User asks "why would someone buy through MY link?"
- User is about to create a landing page and needs the offer angle first
- User wants to increase conversion rates on an existing promotion
- User says anything like "offer", "value proposition", "irresistible", "Hormozi"
- User has a product from S1 and wants to craft the positioning before S4 landing page

## Input Schema

```yaml
product: # REQUIRED — the affiliate product
  name: string # Product name
  description: string # What it does
  reward_value: string # Commission (e.g., "30% recurring")
  url: string # Affiliate link URL
  pricing: string # Product price or pricing page URL
  tags: string[] # e.g., ["ai", "video", "saas"]

target_audience:
  string # OPTIONAL — who you're targeting
  # Default: inferred from product tags

bonuses:
  string[] # OPTIONAL — bonuses you're already offering
  # Default: none (will suggest bonuses)

competitors:
  string[] # OPTIONAL — competing products
  # Default: auto-researched
```

**Chaining from S1**: If `affiliate-program-search` was run earlier, automatically pick up `recommended_program` as the `product` input.

**Chaining from S1 purple-cow-audit**: If `purple-cow-audit` was run, use `remarkability_score` and `remarkable_angles` to inform the offer.

## Workflow

### Step 1: Gather Context

If product data is available from S1 chaining, use it directly. Otherwise:

1. Use `web_search` to research: `"[product name] features pricing review"`
2. Gather: name, pricing tiers, key features, target audience, top 3 competitors
3. If `target_audience` not provided, infer from product positioning and tags

### Step 2: Apply Value Equation

Read `shared/references/offer-frameworks.md` for the Hormozi framework.

For each component of the Value Equation, score the product 1-10 and identify leverage points:

**Dream Outcome (maximize)**

- What is the #1 transformation the audience wants?
- What does life look like AFTER using this product?
- Frame in terms of identity: "Become the person who..."

**Perceived Likelihood (maximize)**

- What proof exists? (case studies, user count, reviews)
- What specific numbers can you cite?
- What demonstration can you offer? (your own results, screenshots)

**Time Delay (minimize)**

- How fast can they see first results?
- What quick wins does the product offer?
- Can you accelerate with your bonuses? (templates, setup guide)

**Effort & Sacrifice (minimize)**

- What's the learning curve?
- What do they have to give up?
- Can you reduce effort with done-for-you assets?

### Step 3: Design the Offer Stack

Build the complete offer:

1. **Core product** — the affiliate product itself with reframed positioning
2. **Your unique angle** — why YOU are the right person to recommend this
3. **Bonus suggestions** — 3-5 bonuses that address the weakest Value Equation components
4. **Guarantee suggestion** — your personal guarantee on top of the product's
5. **Urgency element** — ethical, real urgency (if applicable)

### Step 4: Write Offer Copy

Create ready-to-use copy blocks:

- **Headline**: One sentence that captures the dream outcome
- **Sub-headline**: Addresses the biggest objection
- **Value stack**: Bullet list of everything they get (product + bonuses + guarantee)
- **CTA**: Action-oriented, specific, urgent

### Step 5: Output

Present the complete Grand Slam Offer framework.

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] Value Equation is complete (all 4 components scored and addressed)
- [ ] Offer is differentiated from a generic "buy through my link" promotion
- [ ] Bonuses are specific and deliverable (not vague promises)
- [ ] Guarantee is realistic and scoped to what YOU can deliver
- [ ] Copy is specific to this product (not generic template fill)
- [ ] FTC-compliant — no income claims, no fake urgency

If any check fails, fix before delivering.

## Output Schema

```yaml
output_schema_version: "1.0.0"
grand_slam_offer:
  product_name: string # Product being promoted
  value_equation:
    dream_outcome: string # The transformation promise
    dream_outcome_score: number # 1-10
    likelihood: string # Proof points
    likelihood_score: number # 1-10
    time_delay: string # Speed to results
    time_delay_score: number # 1-10 (lower = better, inverted in output)
    effort: string # Ease of use
    effort_score: number # 1-10 (lower = better, inverted in output)
    total_value_score: number # Calculated composite

  offer_stack:
    unique_angle: string # Your differentiator
    bonuses: object[] # Suggested bonuses
    guarantee: string # Your personal guarantee
    urgency: string # Ethical urgency element

  offer_copy:
    headline: string # Main headline
    sub_headline: string # Objection-addressing sub-headline
    value_stack: string[] # Bullet list of everything included
    cta: string # Call to action text

chain_metadata:
  skill_slug: "grand-slam-offer"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "landing-page-creator"
    - "bonus-stack-builder"
    - "guarantee-generator"
    - "email-drip-sequence"
```

## Output Format

```
## Grand Slam Offer: [Product Name]

### Value Equation Analysis

| Component | Score | Leverage Point |
|---|---|---|
| Dream Outcome | X/10 | [key insight] |
| Perceived Likelihood | X/10 | [key insight] |
| Time Delay | X/10 | [key insight] |
| Effort & Sacrifice | X/10 | [key insight] |
| **Total Value Score** | **X/40** | |

### Your Unique Angle
[Why YOUR recommendation matters]

### Offer Stack
**They get:**
1. [Product] — [reframed benefit] ($XX/mo value)
2. BONUS: [Bonus 1] — [what it solves] ($XX value)
3. BONUS: [Bonus 2] — [what it solves] ($XX value)
4. BONUS: [Bonus 3] — [what it solves] ($XX value)
5. YOUR GUARANTEE: [guarantee statement]

**Total value: $XXX — they pay: $XX/mo**

### Ready-to-Use Copy

**Headline:** [headline]
**Sub-headline:** [sub-headline]

**Value Stack:**
[bullet list]

**CTA:** [call to action]

### Next Steps
- Run `bonus-stack-builder` to flesh out bonus details
- Run `guarantee-generator` to craft your guarantee copy
- Run `landing-page-creator` to build the page with this offer
```

## Error Handling

- **No product provided**: "I need a product to design an offer for. Run `affiliate-program-search` first, or tell me the product name."
- **No pricing found**: Use `web_search` for `"[product] pricing"`. If unavailable, use "Check current pricing" and frame value around ROI instead.
- **Product too generic**: "This product competes in a crowded space. Let me find your unique angle..." → focus on YOUR differentiators (bonuses, expertise, guarantee).
- **No competitive data**: Design the offer based on the product alone. Note: "Run `competitor-spy` for competitive intelligence to sharpen this offer."

## Examples

**Example 1:** "Design a grand slam offer for HeyGen"
→ Research HeyGen features/pricing, score Value Equation, identify unique angle (e.g., "AI video for non-creators"), suggest bonuses (script templates, avatar setup guide, prompt library), write offer copy.

**Example 2:** "I promote Semrush but my conversion rate is low"
→ Analyze why: likely weak differentiation. Score Value Equation, identify weakest component (probably Effort — steep learning curve), design bonuses that reduce effort (done-for-you audit template, keyword research spreadsheet, setup walkthrough).

**Example 3:** "Create an offer for this product" (after S1 + purple-cow-audit)
→ Pick up product data from S1, remarkability angles from purple-cow-audit, design offer that amplifies the most remarkable aspects.

## Flywheel Connections

### Feeds Into

- `landing-page-creator` (S4) — offer copy becomes the page's core messaging
- `bonus-stack-builder` (S4) — offer analysis identifies which bonuses to create
- `guarantee-generator` (S4) — value equation reveals what to guarantee
- `email-drip-sequence` (S5) — offer framing drives email copy
- `value-ladder-architect` (S4) — offer positioning informs ladder design

### Fed By

- `affiliate-program-search` (S1) — product data to build the offer around
- `purple-cow-audit` (S1) — remarkability angles to emphasize
- `competitor-spy` (S1) — competitive gaps to exploit in the offer
- `content-moat-calculator` (S3) — authority gaps inform what to emphasize

### Feedback Loop

- Conversion rate from `conversion-tracker` (S6) reveals which Value Equation components resonated → improve weak components on next offer

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (Grand Slam formula applied)

Any NO → rewrite before delivering. Do not flag this checklist to the user.

## References

- `shared/references/offer-frameworks.md` — Hormozi Value Equation, bonus stack rules, guarantee types, pricing psychology
- `shared/references/ftc-compliance.md` — FTC disclosure requirements (no income claims, no fake urgency)
- `shared/references/affiliate-glossary.md` — Affiliate terminology
- `shared/references/flywheel-connections.md` — Master connection map
