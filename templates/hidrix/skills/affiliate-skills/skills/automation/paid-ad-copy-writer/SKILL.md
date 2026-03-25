---
name: paid-ad-copy-writer
description: >
  Write paid ad copy for affiliate offers across ad platforms. Triggers on:
  "write ad copy", "Facebook ad for affiliate", "Google Ads copy",
  "TikTok ad script", "Pinterest ad", "paid traffic to affiliate",
  "create ad campaign", "ad headlines", "ad descriptions",
  "scale with paid ads", "run ads for my affiliate link",
  "write Facebook ad", "Google Search ad copy".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "automation", "scaling", "workflow", "ads", "ppc", "copywriting"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S7-Automation
---

# Paid Ad Copy Writer

Write paid ad copy for affiliate offers — Facebook Ads, Google Search Ads, Google Display Ads, TikTok Ads, and Pinterest Ads. Each output includes multiple ad variants, targeting suggestions, compliance notes, and campaign setup guidance. Output is platform-formatted ad copy ready to deploy.

## Stage

S7: Automation — When organic content proves profitable, paid ads let you scale 10x faster. But affiliate ad copy has unique constraints: platform policies around affiliate links, FTC disclosure requirements, and the need to drive clicks to a landing page (not direct-link). This skill writes compliant, high-converting ad copy for each platform.

## When to Use

- User wants to run paid traffic to affiliate offers
- User says "write ad copy", "Facebook ad", "Google Ads", "TikTok ad"
- User wants to scale a profitable organic campaign with paid media
- User has a landing page (from S4) and wants ads driving traffic to it
- User wants multiple ad variants for testing
- Chaining from S4 (landing page) → write ads pointing to the landing page

## Input Schema

```yaml
product:
  name: string # REQUIRED — product name
  description: string # OPTIONAL — one-line product description
  reward_value: string # OPTIONAL — commission info
  url: string # OPTIONAL — product URL (for research)
  key_benefits: string[] # OPTIONAL — top 3 benefits

platform:
  string # REQUIRED — "facebook" | "google_search" | "google_display"
  # | "tiktok" | "pinterest"

audience:
  description: string # REQUIRED — target audience
  pain_points: string[] # OPTIONAL — problems the audience has
  demographics: string # OPTIONAL — age, gender, interests

budget: string # OPTIONAL — daily/monthly budget (e.g., "$20/day")

landing_url:
  string # OPTIONAL — destination URL (from S4 or a bridge page)
  # Note: most platforms don't allow direct affiliate links
```

**Chaining context**: If S1 product data exists, pull name, benefits, commission. If S4 landing page was created, use its URL as `landing_url`.

## Workflow

### Step 1: Analyze Product and Audience

Gather product info and audience details. If `key_benefits` is not provided, infer from product name and description using training knowledge.

Identify:

- Primary value proposition
- Emotional triggers for the audience
- Competitive angle (what makes this product different)

### Step 2: Select Ad Format

Each platform has specific formats:

**Facebook Ads**:

- Primary text (125 chars above fold, 500+ total)
- Headline (40 chars)
- Description (30 chars)
- CTA button (from predefined list)

**Google Search Ads**:

- Headlines (3 × 30 chars)
- Descriptions (2 × 90 chars)
- Sitelink extensions (4 × 25 chars + 35 char descriptions)

**Google Display Ads**:

- Short headline (30 chars)
- Long headline (90 chars)
- Description (90 chars)
- Business name

**TikTok Ads**:

- Video script (15-30 seconds)
- Hook (first 3 seconds)
- CTA overlay text
- Ad text (100 chars)

**Pinterest Ads**:

- Pin title (100 chars)
- Pin description (500 chars)
- Image text suggestions

### Step 3: Write Ad Variants

Create 3-5 variants per platform, each testing a different angle:

- **Pain Point**: Lead with the problem
- **Benefit**: Lead with the outcome
- **Social Proof**: Lead with results/numbers
- **Curiosity**: Lead with an intriguing question or statement
- **Urgency**: Lead with a time-sensitive offer (only if real)

### Step 4: Add Compliance Notes

Per platform:

- **Facebook**: "Paid Partnership" label if required. No misleading claims. Landing page must match ad claims. Affiliate links may be flagged — use a bridge/landing page.
- **Google**: Ad must match landing page content. No superlative claims without proof. Affiliate disclaimer on landing page required. Follow Google Ads affiliate policies.
- **TikTok**: #ad or Paid Partnership toggle. No medical/financial advice. Must feel native to platform.
- **Pinterest**: Disclosures in pin description. Must link to content page, not direct affiliate link.

### Step 5: Suggest Targeting

Recommend targeting parameters:

- Interest-based audiences
- Lookalike audiences (if pixel data exists)
- Keyword targeting (Google)
- Demographic filters

### Step 6: Budget Allocation

If budget is provided, suggest:

- Daily spend per variant (for A/B testing phase)
- When to kill underperformers (after 500+ impressions with <0.5% CTR)
- When to scale winners (after 3+ days of profitable ROAS)

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] 3-5 ad variants generated per platform
- [ ] Character counts within platform limits (Google: 30/90 headline/description, Facebook: 40/125/27000)
- [ ] No prohibited claims (income guarantees, before/after without evidence)
- [ ] CTA uses platform-native action verbs
- [ ] Test budget recommendation is realistic ($5-20/day per variant)

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
campaign:
  product: string
  platform: string
  num_variants: number
  landing_url: string

variants:
  - label: string # "Variant A: Pain Point", etc.
    angle: string # the approach used
    copy:
      headline: string # or headlines[] for Google
      description: string # or descriptions[] for Google
      primary_text: string # Facebook only
      cta: string
      video_script: string # TikTok only
    character_counts: object # per field

compliance:
  notes: string[] # platform-specific requirements
  warnings: string[] # things that might get the ad rejected

targeting:
  interests: string[]
  demographics: string
  keywords: string[] # Google only

budget_suggestion:
  test_phase: string # e.g., "$10/day per variant for 5 days"
  scale_phase: string # e.g., "Increase winning variant to $50/day"
  kill_criteria: string # when to stop a variant
```

## Output Format

1. **Campaign Overview** — product, platform, landing URL
2. **Ad Variants** — each variant with full copy in platform format
3. **Compliance Checklist** — platform-specific requirements and warnings
4. **Targeting Suggestions** — interests, demographics, keywords
5. **Budget Guide** — test and scale strategy

## Error Handling

- **No landing URL**: "Most ad platforms don't allow direct affiliate links. I recommend creating a landing page first with S4 (landing-page-creator) and using that as your ad destination."
- **Unknown platform**: "I support Facebook, Google Search, Google Display, TikTok, and Pinterest ads. Which platform would you like ad copy for?"
- **Product with strict ad policies (supplements, finance)**: "This product category has strict advertising policies on [platform]. I'll write compliant copy, but review your ad account's specific restrictions before publishing. Avoid health/income claims."

## Examples

### Example 1: Facebook ad for SaaS product

**User**: "Write Facebook ads for HeyGen targeting content creators. My landing page is example.com/heygen-review"
**Action**: 3 variants. Variant A (pain point): "Spending hours editing videos? HeyGen creates professional AI videos in minutes." Variant B (benefit): "Create studio-quality videos without a camera. 50+ AI avatars, any language." Variant C (social proof): "10,000+ creators switched to HeyGen. Here's why." Each with headline, description, CTA. Include Facebook compliance notes.

### Example 2: Google Search ads

**User**: "Google Search ads for Semrush targeting 'best SEO tools'"
**Action**: 5 headline + 2 description combinations. H1: "Best SEO Tool for 2026" (30 chars). H2: "Try Semrush Free Today" (22 chars). H3: "Trusted by 10M+ Marketers" (25 chars). D1: "Complete SEO toolkit: keyword research, site audit, backlink analysis. Start your free trial." D2: "Outrank your competitors with data-driven SEO. 7-day free trial, no card required." Plus sitelink extensions.

### Example 3: TikTok ad script

**User**: "Write a TikTok ad for Notion targeting college students"
**Action**: 30-second script. Hook (0-3s): "POV: You just discovered the app that replaced 5 other apps." Middle (3-20s): Show use cases (notes, calendar, to-do, project tracker). CTA (20-30s): "Link in bio for the student discount." #ad disclosure. Include compliance notes about TikTok's policies on educational content promotions.

## References

- `shared/references/ftc-compliance.md` — FTC disclosure requirements for paid advertising. Read in Step 4.
- `shared/references/affiliate-glossary.md` — Ad terminology (ROAS, CTR, CPC). Referenced in budget guide.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Paid ads are the fastest way to scale a profitable affiliate funnel. If your organic funnel converts at $2 EPC, and your CPC is $0.50, you're making $1.50 profit per click. At 100 clicks/day = $150/day = $4,500/month profit
- **Benchmark**: Profitable affiliate ad campaigns typically achieve 2-4x ROAS (Return On Ad Spend). Below 1.5x ROAS = unprofitable. Above 3x ROAS = scale aggressively
- **Key metric to track**: ROAS (revenue from commissions / ad spend). Secondary: CPC (cost per click), CTR (click-through rate), and conversion rate on landing page

### Do This Right Now (15 min)

1. **Launch a test campaign** with your top 2 ad variants at $10/day each
2. **Set the destination URL** to your landing page (from `landing-page-creator`), NOT a direct affiliate link
3. **Set a kill rule**: if a variant has 500+ impressions and <0.5% CTR after 48 hours, pause it
4. **Set a scale rule**: if a variant achieves 2x+ ROAS after 5 days, increase budget by 50%

### Track Your Results

After 48 hours: kill any variant with <0.5% CTR. After 5 days: is any variant profitable (ROAS > 1.5x)? If yes, scale it by increasing daily budget. If no variant is profitable, test new angles — the ad copy may not match the audience's pain point. Never scale a losing campaign.

> **Next step — copy-paste this prompt:**
> "Set up conversion tracking for my ad campaign landing page" → runs `conversion-tracker`

## Flywheel Connections

### Feeds Into

- `conversion-tracker` (S6) — ad links to track conversions
- `ab-test-generator` (S6) — ad copy variants for testing

### Fed By

- `affiliate-program-search` (S1) — product data for ad copy
- `grand-slam-offer` (S4) — offer framing for ad messaging
- `landing-page-creator` (S4) — landing page URL as ad destination

### Feedback Loop

- `conversion-tracker` (S6) measures ad ROAS → optimize ad copy, targeting, and budget allocation

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
  skill_slug: "paid-ad-copy-writer"
  stage: "automation"
  timestamp: string
  suggested_next:
    - "conversion-tracker"
    - "ab-test-generator"
    - "landing-page-creator"
```
