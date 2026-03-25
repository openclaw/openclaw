---
name: ab-test-generator
description: >
  Generate A/B test variants for affiliate content. Triggers on:
  "create A/B test", "test my headline", "optimize my CTA", "generate variants",
  "split test ideas", "improve click-through rate", "test my landing page copy",
  "headline alternatives", "CTA variations", "which version is better",
  "optimize conversions", "test my email subject line", "compare approaches".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "analytics", "optimization", "tracking", "ab-testing", "experiments"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S6-Analytics
---

# A/B Test Generator

Generate A/B test variants for affiliate content — headlines, CTAs, landing page sections, email subject lines, and social post hooks. Each variant includes a hypothesis explaining why it might outperform the original. Output is a Markdown document with the original, variants, hypotheses, and a test plan.

## Stage

S6: Analytics — Small changes in headlines and CTAs can swing conversion rates by 20-50%. A/B testing is how professional affiliates systematically find what converts best. This skill removes the guesswork by generating theory-driven variants using proven copywriting frameworks.

## When to Use

- User wants to improve conversion rates on existing content
- User has a headline, CTA, or email subject line and wants alternatives
- User says "test my headline", "optimize my CTA", "A/B test ideas"
- User has a landing page section that isn't converting
- User wants to compare different messaging approaches
- Chaining from S2-S5: take any content output and generate test variants

## Input Schema

```yaml
original:
  string # REQUIRED — the content to test (headline, CTA, paragraph,
  # email subject line, or full social post)

content_type:
  string # REQUIRED — "headline" | "cta" | "landing_section"
  # | "email_subject" | "social_hook"

goal:
  string # OPTIONAL — "clicks" | "signups" | "purchases"
  # Default: "clicks"

num_variants:
  number # OPTIONAL — number of variants to generate (2-5)
  # Default: 3

audience:
  string # OPTIONAL — who sees this content
  # (e.g., "SaaS founders", "content creators")

product: string # OPTIONAL — product being promoted
```

**Chaining context**: If S2-S5 content exists in conversation, the user can reference it: "test the headline from my blog post" or "generate CTA variants for my landing page."

## Workflow

### Step 1: Analyze Original Content

Break down the original into components:

- **Emotional angle**: What emotion does it trigger? (curiosity, fear, desire, urgency)
- **Specificity**: How specific vs vague?
- **Structure**: Question, statement, command, statistic?
- **Framework**: Which copywriting framework does it follow? (PAS, AIDA, 4U, BAB)

### Step 2: Identify Testable Elements

Determine what to vary:

- Emotional angle (switch from curiosity to urgency)
- Specificity (add numbers, remove vagueness)
- Structure (question vs statement)
- Length (shorter vs longer)
- Power words (swap key words for stronger alternatives)
- Social proof (add or remove)

### Step 3: Generate Variants

Create `num_variants` alternatives, each using a different approach:

- **Variant A**: Different emotional angle
- **Variant B**: Different structure/format
- **Variant C**: Different specificity level
- Additional variants explore social proof, urgency, or contrarian angles

Each variant must:

- Preserve the core message and product reference
- Preserve any FTC disclosure from the original
- Be a realistic alternative (not just a word swap)

### Step 4: Write Hypotheses

For each variant, explain:

- What was changed and why
- Which copywriting principle supports the change
- What behavior change is expected (e.g., "Higher CTR because questions create open loops")

### Step 5: Suggest Test Plan

Recommend:

- Sample size needed (minimum 100 impressions per variant for social, 500 for landing pages)
- Test duration (7-14 days minimum)
- What metric to track (CTR, conversion rate, revenue per visitor)
- When to declare a winner (95% statistical significance or practical significance threshold)

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] 3-5 distinct variants generated (not just word swaps)
- [ ] Each hypothesis grounded in a copywriting principle or framework
- [ ] Sample size calculation is present and realistic
- [ ] Test duration is ≥7 days minimum
- [ ] Winner criteria defined with statistical significance threshold

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
test:
  original: string
  content_type: string
  goal: string

variants:
  - label: string # "Variant A", "Variant B", etc.
    content: string # the variant text
    change: string # what was changed
    framework: string # copywriting principle used
    hypothesis: string # why this might win

test_plan:
  sample_size: number # per variant
  duration: string # recommended test period
  metric: string # what to measure
  winner_criteria: string # when to pick a winner
```

## Output Format

1. **Original** — the current content being tested
2. **Variants** — each variant with its content, change description, and hypothesis
3. **Test Plan** — sample size, duration, metric, winner criteria
4. **Quick Win** — if one variant is clearly stronger based on copywriting principles, call it out

## Error Handling

- **Original too short (1-2 words)**: "I need more context. Paste the full headline, CTA, or email subject line you want to test."
- **Content type unclear**: "Is this a headline, CTA button text, email subject line, or social post hook? Knowing the format helps me generate better variants."
- **Too many variants requested (>5)**: "I'll generate 5 high-quality variants. More than 5 makes testing impractical — you'd need a very large audience to reach statistical significance."

## Examples

### Example 1: Blog headline test

**User**: "Test this headline: 'HeyGen Review: Is It Worth It in 2026?'"
**Action**: Generate 3 variants. Variant A: "I Tested HeyGen for 30 Days — Here's What Happened" (curiosity + personal experience). Variant B: "HeyGen vs Synthesia: Which AI Video Tool Wins?" (comparison + specificity). Variant C: "The AI Video Tool That Cut My Production Time by 80%" (result + specificity). Each with hypothesis.

### Example 2: CTA button test

**User**: "Optimize this CTA: 'Start Free Trial'"
**Action**: Variant A: "Try HeyGen Free — No Card Required" (reduces friction). Variant B: "Create Your First AI Video in 2 Minutes" (outcome-focused). Variant C: "Get Started Free →" (shorter, action-oriented). Test plan: minimum 500 clicks per variant, track conversion rate.

### Example 3: Email subject line test

**User**: "I'm sending an email about Semrush. Test this subject: 'Check out Semrush — it's great for SEO'"
**Action**: Identify weakness (vague, no hook). Variant A: "The SEO tool I use to rank #1 (not kidding)" (social proof + curiosity). Variant B: "Your competitors are using this — are you?" (FOMO). Variant C: "3 Semrush features that doubled my organic traffic" (specificity + result). Each preserves FTC compliance.

## References

- `shared/references/ftc-compliance.md` — Ensure variants preserve FTC disclosure from original. Referenced in Step 3.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `purple-cow-audit` (S1) — winning variants reveal what resonates = what's remarkable
- `performance-report` (S6) — test results for reporting

### Fed By

- `viral-post-writer` (S2) — posts to test variations of
- `twitter-thread-writer` (S2) — thread hooks to test
- `landing-page-creator` (S4) — landing page elements to test
- `content-pillar-atomizer` (S2) — volume mode variants for testing

### Feedback Loop

- Test results directly improve all content-producing skills → winning headlines, CTAs, and angles feed into next content creation cycle

```yaml
chain_metadata:
  skill_slug: "ab-test-generator"
  stage: "analytics"
  timestamp: string
  suggested_next:
    - "performance-report"
    - "viral-post-writer"
    - "landing-page-creator"
```
