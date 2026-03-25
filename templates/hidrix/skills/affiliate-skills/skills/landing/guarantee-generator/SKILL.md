---
name: guarantee-generator
description: >
  Create YOUR personal guarantee on top of the product's guarantee for risk reversal.
  Triggers on: "create a guarantee", "guarantee for my affiliate", "risk reversal",
  "money back guarantee", "what guarantee can I offer", "reduce buyer risk",
  "guarantee copy", "how to guarantee", "affiliate guarantee", "personal guarantee",
  "risk-free offer", "satisfaction guarantee", "results guarantee".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "landing-pages", "conversion", "offers", "guarantees", "risk-reversal"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Guarantee Generator

Create YOUR personal guarantee that sits on top of the product's built-in guarantee. Addresses the gap: "What if I buy through your link and it doesn't work for me?" Risk reversal is the most underleveraged conversion tool in affiliate marketing.

## Stage

S4: Landing — Guarantees are landing page copy. They directly impact conversion by removing the last barrier to clicking your affiliate link.

## When to Use

- User wants to increase conversion by reducing buyer perceived risk
- User asks "what guarantee can I offer as an affiliate?"
- User says "guarantee", "risk reversal", "risk-free", "money back"
- After running `grand-slam-offer` or `bonus-stack-builder` to complete the offer
- User has low conversion rates and needs to address trust/risk objections

## Input Schema

```yaml
product: # REQUIRED
  name: string # Product name
  pricing: string # Product price
  has_free_trial: boolean # Does the product offer a free trial?
  has_guarantee: string # Product's existing guarantee (e.g., "30-day money back")

your_bonuses:
  string[] # OPTIONAL — bonuses from bonus-stack-builder
  # Default: none

your_capacity:
  string # OPTIONAL — "low" | "medium" | "high"
  # How much personal time you can invest
  # Default: "medium"

audience_fears:
  string[] # OPTIONAL — top objections/fears
  # Default: inferred from product type
```

**Chaining from S4 bonus-stack-builder**: Use `bonus_stack.bonuses` to reference specific bonuses in guarantee.

**Chaining from S4 grand-slam-offer**: Use `value_equation` to target the weakest component with the guarantee.

## Workflow

### Step 1: Gather Context

1. Understand the product's existing guarantee/refund policy
2. Identify top 3 buyer fears for this product category
3. Assess user's capacity to deliver on guarantee promises

### Step 2: Design Guarantee Options

Read `shared/references/offer-frameworks.md` for guarantee types.

Create 3 guarantee options at different commitment levels:

**Option A: Light Touch** (low capacity)

- Scope: Your bonuses only
- Example: "If my bonuses don't help you get started faster, I'll refund their value"
- Risk to you: Minimal

**Option B: Support Guarantee** (medium capacity)

- Scope: Your time + bonuses
- Example: "If you're stuck after 30 days, I'll personally help you implement for 1 hour"
- Risk to you: Moderate (capped time)

**Option C: Results Guarantee** (high capacity)

- Scope: Specific outcome
- Example: "If you don't [specific measurable result] in [timeframe], I'll [specific action]"
- Risk to you: Higher (but highest conversion impact)

### Step 3: Write Guarantee Copy

For each option, produce:

1. **Guarantee headline** — bold, specific, confident
2. **Guarantee body** — exactly what you promise, the conditions, and the timeframe
3. **Claim process** — how they reach you if they want to use the guarantee
4. **Fine print** — fair conditions (must actually use the product, specific timeframe)

### Step 4: Recommend Best Fit

Based on `your_capacity` and product type, recommend one guarantee with reasoning.

### Step 5: Self-Validation

- [ ] Guarantee is specific (not vague "satisfaction guaranteed")
- [ ] Guarantee is scoped to what YOU can deliver (not the product's features)
- [ ] Guarantee has a clear timeframe
- [ ] Claim process is simple and accessible
- [ ] Guarantee is realistic — you can actually fulfill it
- [ ] No guarantees about income or specific financial results (FTC)

## Output Schema

```yaml
output_schema_version: "1.0.0"
guarantee:
  product_name: string
  recommended_option: string # "A" | "B" | "C"
  options:
    - level: string # "light" | "support" | "results"
      headline: string
      body: string
      claim_process: string
      timeframe: string
      risk_to_you: string # "minimal" | "moderate" | "higher"
      conversion_impact: string # "moderate" | "high" | "very high"

chain_metadata:
  skill_slug: "guarantee-generator"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "landing-page-creator"
    - "email-drip-sequence"
```

## Output Format

```
## Your Guarantee: [Product Name]

### Product's Existing Guarantee
[What the product already offers]

### YOUR Guarantee Options

#### Option A: Light Touch ⚡
**"[Guarantee headline]"**
[Body copy]
- Timeframe: [X days]
- Claim: [how to claim]
- Risk to you: Minimal

#### Option B: Support Guarantee 🤝
**"[Guarantee headline]"**
[Body copy]
- Timeframe: [X days]
- Claim: [how to claim]
- Risk to you: Moderate

#### Option C: Results Guarantee 🎯
**"[Guarantee headline]"**
[Body copy]
- Timeframe: [X days]
- Claim: [how to claim]
- Risk to you: Higher

### Recommended: Option [X]
[Why this option fits your situation]

### Ready-to-Use Copy
[Complete guarantee section copy, ready to paste into landing page]
```

## Error Handling

- **No product provided**: "I need a product to create a guarantee for. Tell me the product or run `affiliate-program-search` first."
- **User uncomfortable with guarantees**: Emphasize Option A — low risk, still impactful. "Even a light guarantee outperforms no guarantee."
- **Product has no refund policy**: Note this as a risk factor. Design guarantee around YOUR bonuses only (Option A).
- **User wants to guarantee income/results**: Flag FTC risk. Reframe to process guarantees: "I guarantee I'll help you implement" not "I guarantee you'll make $X".

## Examples

**Example 1:** "Create a guarantee for my HeyGen promotion"
→ Research HeyGen's refund policy, identify fears (is AI video quality good enough? will I look stupid?), create 3 options ranging from "bonus refund" to "I'll personally record your first video with you."

**Example 2:** "I don't have much time but want to offer a guarantee for Semrush"
→ your_capacity=low → Recommend Option A: "If my SEO audit template doesn't save you 3+ hours, email me and I'll personally audit one page for you." Low time commitment, high perceived value.

**Example 3:** "Design a results guarantee" (after grand-slam-offer + bonus-stack)
→ Use value equation weakness (e.g., time delay) as guarantee target: "If you haven't created your first campaign within 48 hours using my setup guide, I'll do it for you on a screenshare."

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Adding a personal guarantee increases conversion rates by 15-30%. If your landing page converts at 2% with 1,000 monthly visitors = 20 sales × $50 = $1,000/month. With a guarantee at 2.5% = 25 sales = $1,250/month — an extra $250/month for 30 minutes of work
- **Benchmark**: Results guarantees (Option C) show the highest conversion lift (25-30%) but carry more risk. Support guarantees (Option B) offer the best risk-reward balance (15-20% lift, capped time commitment)
- **Key metric to track**: Conversion rate before vs after adding the guarantee. Also track guarantee claim rate — if <5% of buyers claim the guarantee, you're safe to offer bolder guarantees

### Do This Right Now (15 min)

1. Pick the **Recommended option** from the output
2. Copy the "Ready-to-Use Copy" section and paste it directly into your landing page
3. Add your contact email/DM as the claim channel
4. If you don't have a landing page yet, run `landing-page-creator` with the guarantee section included

### Track Your Results

After 30 days: did conversion rate increase? How many people claimed the guarantee? If zero claims after 50+ sales, consider upgrading to a bolder guarantee (more conversion lift, same low risk).

> **Next step — copy-paste this prompt:**
> "Create a landing page for [product] with this guarantee and my bonus stack" → runs `landing-page-creator`

## Flywheel Connections

### Feeds Into

- `landing-page-creator` (S4) — guarantee copy for the guarantee section
- `email-drip-sequence` (S5) — guarantee as conversion lever in emails

### Fed By

- `grand-slam-offer` (S4) — value equation identifies what to guarantee
- `bonus-stack-builder` (S4) — specific bonuses to scope guarantee around

### Feedback Loop

- `conversion-tracker` (S6) measures if guarantee increases conversion rate → refine guarantee scope and messaging

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (guarantee makes saying yes feel safe)

Any NO → rewrite before delivering.

## References

- `shared/references/offer-frameworks.md` — Guarantee types, rules, and examples
- `shared/references/ftc-compliance.md` — FTC rules on guarantee claims
- `shared/references/flywheel-connections.md` — Master connection map
