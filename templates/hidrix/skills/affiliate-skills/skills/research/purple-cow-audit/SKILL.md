---
name: purple-cow-audit
description: >
  Score product remarkability 1-10 to decide if it's worth promoting. Seth Godin's Purple Cow test.
  Triggers on: "is this product worth promoting", "should I promote", "product audit",
  "purple cow", "remarkable product", "is it remarkable", "rate this product",
  "product quality check", "worth my reputation", "product evaluation",
  "would I recommend without commission", "product remarkability score",
  "evaluate this affiliate product", "quality gate for promotion".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "research",
    "niche-analysis",
    "program-discovery",
    "differentiation",
    "positioning",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Purple Cow Audit

Quality gate for affiliate marketers: score a product's remarkability 1-10 before promoting it. Based on Seth Godin's Purple Cow — if the product isn't remarkable, no amount of marketing skill will make it convert sustainably. The key question: "Would I recommend this to a friend WITHOUT earning a commission?"

## Stage

S1: Research — Evaluating a program's worthiness IS part of research and discovery. This is a quality gate before you invest time creating content, landing pages, and email sequences.

## When to Use

- User is considering promoting a specific product
- User asks "is this product worth promoting?"
- User wants to evaluate product quality before investing time
- User says "purple cow", "remarkable", "audit", "evaluate", "quality check"
- Before investing time in S2-S5 skills for a specific product
- User has a list of programs from `affiliate-program-search` and needs to pick the best

## Input Schema

```yaml
product: # REQUIRED
  name: string # Product name
  url: string # Product website
  description: string # OPTIONAL — what it does
  reward_value: string # OPTIONAL — commission rate
  tags: string[] # OPTIONAL — categories

comparison_products:
  string[] # OPTIONAL — competitors to compare against
  # Default: auto-discovered
```

**Chaining from S1 affiliate-program-search**: If run, evaluate the `recommended_program`.

## Workflow

### Step 1: Research the Product

1. `web_search`: `"[product] review 2024 2025"` — find recent reviews
2. `web_search`: `"[product] vs" OR "[product] alternative"` — find competitors
3. `web_search`: `"[product] complaints" OR "[product] problems"` — find issues
4. Check product website for: pricing transparency, unique features, social proof

### Step 2: Score Remarkability

Rate each dimension 1-10:

| Dimension         | Question                                              | Weight |
| ----------------- | ----------------------------------------------------- | ------ |
| **Uniqueness**    | Does it do something no competitor does?              | 20%    |
| **Quality**       | Is it genuinely excellent at its core job?            | 20%    |
| **Story**         | Does using it make you feel/look different?           | 15%    |
| **Word of mouth** | Would users tell friends unprompted?                  | 15%    |
| **Design**        | Is the experience delightful, not just functional?    | 10%    |
| **Problem fit**   | Does it solve a real, painful problem?                | 10%    |
| **Trust**         | Transparent pricing, good support, real social proof? | 10%    |

**Composite score** = weighted average (1-10)

### Step 3: Make Recommendation

Based on composite score:

- **8-10: PROMOTE** — This is a Purple Cow. Go all in.
- **6-7: PROMOTE WITH ANGLE** — Good product, needs strong positioning. Identify your unique angle.
- **4-5: CAUTION** — Mediocre product. Only promote if commission is exceptional AND you can add significant value through bonuses.
- **1-3: SKIP** — Not remarkable. Promoting this will damage your reputation. Find an alternative.

### Step 4: Identify Remarkable Angles

For products scoring 6+, identify:

1. The 1-2 features that ARE remarkable (Purple Cow elements)
2. The angles that make it share-worthy
3. The audience segment for whom this IS a Purple Cow (even if not for everyone)

### Step 5: Self-Validation

- [ ] Score is evidence-based (cited reviews, features, data)
- [ ] Recommendation is honest (not inflated by high commission)
- [ ] Remarkable angles are specific (not generic praise)
- [ ] Comparison with competitors is fair
- [ ] The "would I recommend without commission" test was honestly applied

## Output Schema

```yaml
output_schema_version: "1.0.0"
purple_cow_audit:
  product_name: string
  composite_score: number # 1-10 weighted
  recommendation: string # "promote" | "promote_with_angle" | "caution" | "skip"
  scores:
    uniqueness: number
    quality: number
    story: number
    word_of_mouth: number
    design: number
    problem_fit: number
    trust: number

  remarkable_angles: string[] # What makes it a Purple Cow (for 6+)
  red_flags: string[] # Concerns identified
  alternative_products: string[] # Better options if score < 6

remarkability_score: number # Alias for composite_score (for chaining)

chain_metadata:
  skill_slug: "purple-cow-audit"
  stage: "research"
  timestamp: string
  suggested_next:
    - "affiliate-program-search"
    - "grand-slam-offer"
    - "viral-post-writer"
    - "monopoly-niche-finder"
```

## Output Format

```
## Purple Cow Audit: [Product Name]

### The Question
Would I recommend [product] to a friend WITHOUT earning a commission?
**Answer:** [Yes/No/With caveats]

### Remarkability Scorecard

| Dimension | Score | Evidence |
|---|---|---|
| Uniqueness | X/10 | [specific evidence] |
| Quality | X/10 | [specific evidence] |
| Story | X/10 | [specific evidence] |
| Word of Mouth | X/10 | [specific evidence] |
| Design | X/10 | [specific evidence] |
| Problem Fit | X/10 | [specific evidence] |
| Trust | X/10 | [specific evidence] |
| **Composite** | **X/10** | |

### Recommendation: [PROMOTE / PROMOTE WITH ANGLE / CAUTION / SKIP]

[Reasoning — 2-3 sentences]

### Remarkable Angles (what to emphasize)
1. [Specific remarkable feature/aspect]
2. [Specific remarkable feature/aspect]

### Red Flags (what to be honest about)
1. [Concern]
2. [Concern]

### If Score < 6: Better Alternatives
- [Alternative 1] — [why it's more remarkable]
- [Alternative 2] — [why it's more remarkable]
```

## Error Handling

- **No product provided**: "Tell me the product name and I'll audit its remarkability. Or run `affiliate-program-search` first."
- **Product is too new/no reviews**: Score based on available data, flag low confidence. "Limited data — revisit this audit in 3 months."
- **User disagrees with score**: "The score is a starting framework. If you have personal experience that changes the picture, tell me and I'll adjust."
- **No alternatives found**: Suggest running `affiliate-program-search` in the same category.

## Examples

**Example 1:** "Is HeyGen worth promoting?"
→ Research reviews, features, competitors. Score across 7 dimensions. Result: 8/10 PROMOTE — remarkable for AI avatar quality, unique lip-sync tech, strong word of mouth.

**Example 2:** "Evaluate these 3 programs from my search results"
→ Score all 3 side-by-side. Compare composite scores. Recommend the Purple Cow.

**Example 3:** "Should I promote this random SaaS tool?" (generic tool, many competitors)
→ Research reveals: 5/10 CAUTION — competent but unremarkable. 4 competitors do the same thing. Suggest finding a more remarkable alternative or targeting a micro-audience where it IS remarkable.

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Choosing an 8+/10 product vs a 5/10 product means 3-5x higher conversion rates. At the same traffic, that's $300-1,500/month vs $100-300/month. Product selection is the highest-leverage decision in affiliate marketing
- **Benchmark**: Products scoring 8+ convert at 3-5% CTR, while 4-5 products convert at 0.5-1%. The difference compounds over months
- **Key metric to track**: EPC (Earnings Per Click) — after 30 days of promotion, compare your EPC against the program's network average. If yours is below average, the product may not resonate with YOUR audience

### Do This Right Now (15 min)

- **If PROMOTE (8-10)**: Run `grand-slam-offer` immediately — design your irresistible offer around the remarkable angles identified. Then start creating content today
- **If PROMOTE WITH ANGLE (6-7)**: Run `monopoly-niche-finder` to find the specific audience segment where this IS remarkable. Don't promote to a general audience
- **If CAUTION/SKIP (1-5)**: Run `affiliate-program-search` to find a better product in the same niche. Don't waste months promoting a mediocre product

### Track Your Results

After promoting for 30 days: check EPC. If below $0.50, re-audit the product — the market may not find it as remarkable as the audit suggested. Switch products early; sunk cost is the biggest affiliate mistake.

> **Next step — copy-paste this prompt:**
> "Design an irresistible offer for [product] using these remarkable angles: [list from audit]" → runs `grand-slam-offer`

## Flywheel Connections

### Feeds Into

- `grand-slam-offer` (S4) — remarkable angles become the offer's core messaging
- `viral-post-writer` (S2) — remarkable elements are what makes content shareable
- `affiliate-blog-builder` (S3) — audit insights inform honest review content
- `landing-page-creator` (S4) — remarkable features highlighted on the page

### Fed By

- `affiliate-program-search` (S1) — products to evaluate
- `competitor-spy` (S1) — competitive landscape for comparison

### Feedback Loop

- `ab-test-generator` (S6) reveals which remarkable angles resonate with audience → refine what "remarkable" means for your specific audience

## References

- `shared/references/case-studies.md` — Real affiliate success stories
- `shared/references/affiliate-glossary.md` — Terminology
- `shared/references/flywheel-connections.md` — Master connection map
