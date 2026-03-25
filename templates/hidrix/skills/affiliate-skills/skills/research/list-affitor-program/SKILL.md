---
name: list-affitor-program
description: >
  Research an affiliate program and create a verified listing for list.affitor.com.
  Use this skill when the user asks anything about listing a program, adding an affiliate
  program to the directory, submitting a program to list, creating a listing, documenting
  an affiliate program, sharing an affiliate program, writing a program profile, posting
  a program to list.affitor.com, or contributing a new program.
  Also trigger for: "list a program", "add affiliate program", "submit program to list",
  "create listing for X", "document affiliate program", "share affiliate program",
  "write a listing", "post to list.affitor.com", "add X to the directory",
  "register an affiliate program", "publish affiliate program", "new program listing",
  "profile this affiliate program", "catalog this program".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "research", "listing", "directory", "commission", "program-profile"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Affiliate Program Lister

Research an affiliate program from official sources and produce a verified, publish-ready
listing for [list.affitor.com](https://list.affitor.com). Every number comes from the
program's official affiliate page, network page, or pricing page. No guessing.

## Stage

This skill belongs to Stage S1: Research

## When to Use

- User wants to add an affiliate program to list.affitor.com
- User wants to document a program's commission structure in a standard format
- User found a program and wants to create a shareable profile for other affiliates
- User is contributing to the community directory
- User says "list this program" or "add X to the directory"

## Input Schema

```
{
  program_name: string       # (required) Name of the affiliate program, e.g., "HeyGen"
  affiliate_link: string     # (optional) User's affiliate link to include in the listing
  niche: string              # (optional) Category hint, e.g., "AI video", "email marketing"
}
```

## Workflow

### Step 1: Confirm Program and Context

Confirm the program name with the user. Ask:

- Do you have an affiliate link for this program? (optional — used for verification only)
- What niche or category does it fall under? (helps with tagging)

If the user says "just list it" or provides enough context, skip questions and proceed.

### Step 2: Research from Official Sources

Research the program using only official, verifiable sources. Search in this order:

1. **Official affiliate/partner page** — `web_search "[program name] affiliate program"` or
   `web_search "[program name] partner program"`. This is the primary source for commission
   structure, cookie duration, payment terms, and signup link.

2. **Affiliate network page** — If the program runs through a network (ShareASale, CJ,
   Impact, PartnerStack, Rewardful, etc.), find the network listing for additional details.

3. **Official pricing page** — `web_search "[program name] pricing"`. Needed to calculate
   realistic earnings (commission % means nothing without knowing the price).

4. **Credibility signals** — Look for: number of customers, notable clients, funding raised,
   year founded, G2/Capterra rating, social proof. These go in the description.

For each data point, note the source. If a value cannot be verified from official sources,
mark it as "unverified" in the output.

### Step 3: Extract Listing Fields

Fill in the structured listing fields from the research:

| Field             | Source                | Notes                                                                          |
| ----------------- | --------------------- | ------------------------------------------------------------------------------ |
| `name`            | Official product name | Exact capitalization from their website                                        |
| `url`             | Product homepage      | Main website, not affiliate signup page                                        |
| `reward_type`     | Affiliate page        | One of: `cpc`, `cpl`, `cps_one_time`, `cps_recurring`, `cps_lifetime`, `other` |
| `reward_value`    | Affiliate page        | e.g., "30%", "$50", "$0.10 per click"                                          |
| `reward_duration` | Affiliate page        | For recurring: "12 months", "lifetime", etc. Omit for one-time                 |
| `cookie_days`     | Affiliate page        | Number only. If not stated, mark "unverified" and estimate from network norms  |
| `tags`            | Niche + features      | 3-6 lowercase tags, e.g., `["ai", "video", "saas"]`                            |

**Reward type mapping:**

- "X% of each sale" (one purchase) → `cps_one_time`
- "X% recurring" or "X% for Y months" → `cps_recurring`
- "X% for life of customer" → `cps_lifetime`
- "Pay per lead / free trial signup" → `cpl`
- "Pay per click" → `cpc`
- Anything else → `other` (explain in description)

### Step 4: Write the Description

The description is structured markdown that helps affiliates decide if the program is worth
promoting. Write these sections in order:

**Opening (2-3 sentences)**
What the product does, who it serves, and why affiliates should care. Lead with the value
proposition, not the company history.

**Why Promote This Program**
3-5 bullet points covering: commission rate highlights, cookie duration, payment reliability,
product-market fit, conversion-friendly features (free trial, demo, low friction signup).

**Commission Structure**
A markdown table with all commission tiers if multiple exist:

```
| Plan | Price | Commission | Per Sale | Type |
|------|-------|-----------|----------|------|
| Starter | $29/mo | 30% | $8.70/mo | Recurring |
| Pro | $89/mo | 30% | $26.70/mo | Recurring |
| Enterprise | Custom | 30% | Varies | Recurring |
```

Include: minimum payout threshold, payment methods (PayPal, wire, etc.), payment frequency
(monthly, net-30, etc.) if found.

**Target Audiences**
Who can promote this product effectively. List 3-5 specific audience types with brief
reasoning, e.g., "YouTube creators making tutorial content — visual product, easy to demo."

**Earning Potential**
Realistic earnings at three traffic levels using conservative conversion assumptions
(2% CTR, 2% conversion rate):

```
| Monthly Traffic | Est. Sales | Monthly Earnings | Annual Earnings |
|----------------|-----------|-----------------|----------------|
| 5,000 visitors | 2 | $X | $X |
| 20,000 visitors | 8 | $X | $X |
| 100,000 visitors | 40 | $X | $X |
```

For recurring programs, show month-12 compounded earnings, not just month-1.

**Why It Converts**
2-3 sentences on what makes this product easy to sell: free tier, strong brand recognition,
low-commitment entry point, visual demo potential, etc.

**Honest Limitations**
2-3 bullet points on real drawbacks. Every program has them. Examples: short cookie window,
high competition from other affiliates, niche audience only, high price point limits
conversions, payout threshold too high for beginners.

### Step 5: Verify Affiliate Link (If Provided)

If the user provided an affiliate link:

- Check that the domain matches the program's known affiliate tracking domain
- Check for expected URL parameters (ref=, aff=, via=, etc.)
- Flag if the link looks malformed or suspicious
- Do NOT click the link or test it — just validate the format

### Step 6: Assemble Output

Present the output in two clearly separated parts:

1. **Listing Fields** — structured data ready for API submission
2. **Description** — the full markdown content

### Step 7: Optional API Submission

If the user wants to submit the listing directly:

```
POST https://list.affitor.com/api/v1/programs
Content-Type: application/json
Authorization: Bearer <API_KEY>

{
  "name": "...",
  "url": "...",
  "description": "...",
  "reward_type": "...",
  "reward_value": "...",
  "reward_duration": "...",
  "cookie_days": 30,
  "tags": ["...", "..."]
}
```

If no API key is available, format the output so the user can copy-paste it into the
list.affitor.com submission form.

### Step 8: Self-Validation

Before presenting output, verify:

- [ ] `name` matches official product name (exact capitalization)
- [ ] `reward_value` comes from the official affiliate page, not estimated
- [ ] `reward_type` uses one of the allowed enum values
- [ ] `cookie_days` is a number from official source or explicitly marked "unverified"
- [ ] Commission table math is correct (price x percentage = per-sale amount)
- [ ] Earning potential uses conservative assumptions (2% CTR, 2% CR) not optimistic ones
- [ ] Honest Limitations section contains real drawbacks, not filler
- [ ] No data was hallucinated — every number traces to a source

If any check fails, fix the output before delivering. Do not flag the checklist to the
user — just ensure the output passes.

## Output Schema

Other skills consume these fields from conversation context:

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  listing: {
    name: string              # "HeyGen"
    url: string               # "https://heygen.com"
    description: string       # Full markdown description (all sections)
    reward_type: string       # "cps_recurring" — enum: cpc, cpl, cps_one_time, cps_recurring, cps_lifetime, other
    reward_value: string      # "30%" or "$50"
    reward_duration: string   # "12 months" | "lifetime" | null (for one-time)
    cookie_days: number       # 60
    tags: string[]            # ["ai", "video", "saas"]
  }
  sources: {
    affiliate_page: string    # URL of official affiliate page
    pricing_page: string      # URL of pricing page
    network: string | null    # "PartnerStack", "ShareASale", etc.
  }
  verification: {
    all_fields_verified: boolean  # true if every field from official source
    unverified_fields: string[]   # ["cookie_days"] if any field could not be confirmed
  }
}
```

## Output Format

```
## Listing Fields

| Field | Value |
|-------|-------|
| Name | [Product Name] |
| URL | [https://product.com] |
| Reward Type | [cps_recurring] |
| Reward Value | [30%] |
| Reward Duration | [12 months] |
| Cookie Days | [60] |
| Tags | [ai, video, saas] |

**Sources:** Affiliate page: [URL] | Pricing page: [URL] | Network: [Name or "Direct"]

---

## Description

[Opening paragraph]

### Why Promote This Program

- [Bullet 1]
- [Bullet 2]
- [Bullet 3]

### Commission Structure

| Plan | Price | Commission | Per Sale | Type |
|------|-------|-----------|----------|------|
| ... | ... | ... | ... | ... |

Payment: [method], [frequency], [minimum payout]

### Target Audiences

- **[Audience 1]** — [why they can promote this]
- **[Audience 2]** — [why they can promote this]
- **[Audience 3]** — [why they can promote this]

### Earning Potential

| Monthly Traffic | Est. Sales | Monthly Earnings | Annual Earnings |
|----------------|-----------|-----------------|----------------|
| 5,000 visitors | [X] | $[X] | $[X] |
| 20,000 visitors | [X] | $[X] | $[X] |
| 100,000 visitors | [X] | $[X] | $[X] |

*Assumes 2% CTR, 2% conversion rate. [Recurring note if applicable.]*

### Why It Converts

[2-3 sentences]

### Honest Limitations

- [Limitation 1]
- [Limitation 2]
- [Limitation 3]

---

**Ready to submit?** Copy the Listing Fields above into list.affitor.com, or use the API
with your API key.
```

## Error Handling

- **Program has no affiliate program:** Tell the user clearly. Suggest checking back later
  or searching for similar programs that do offer affiliates. Do not fabricate commission data.
- **Affiliate page is behind a login wall:** Note that commission details could not be
  verified from public sources. Use network listing or trusted third-party sources as
  fallback. Mark unverified fields explicitly.
- **Data is unclear or conflicting:** When sources disagree (e.g., affiliate page says 20%
  but network says 25%), note both values and flag the discrepancy. Let the user decide
  which to use.
- **Program recently changed terms:** If the affiliate page mentions "updated" or "new"
  commission rates, note the date if available and flag that terms may change.
- **Pricing is usage-based or custom:** Use the most common plan tier for earning
  calculations. Note the assumption. For enterprise-only pricing, use "Contact sales" and
  skip per-sale calculations for that tier.
- **Cookie duration not stated:** Mark as "unverified" and note the network default
  (ShareASale: typically 30d, Impact: varies, PartnerStack: typically 90d). Do not guess.

## Examples

**Example 1: SaaS with recurring commission**
User: "List HeyGen's affiliate program"

- Search official affiliate page → 30% recurring, 60-day cookie, via PartnerStack
- Pricing page → Creator $29/mo, Business $89/mo, Enterprise custom
- Build commission table: Creator = $8.70/mo, Business = $26.70/mo
- Earning potential at 5K visitors: ~2 sales/mo = $17-53/mo (month 1), compounding
- Tags: ai, video, saas, content-creation
- Limitations: competitive niche, product requires learning curve

**Example 2: One-time commission program**
User: "Add Bluehost affiliate program to the list"

- Search → $65+ per signup (one-time), 90-day cookie, direct program
- Pricing → Basic $2.95/mo, Plus $5.45/mo, Choice Plus $5.45/mo
- reward_type: cps_one_time, reward_value: "$65+"
- Earning potential: straightforward per-sale math, no compounding
- Tags: hosting, wordpress, web-hosting, beginner-friendly
- Limitations: saturated market, aggressive competitor affiliates, low-margin hosting

**Example 3: Program with unverifiable data**
User: "Create a listing for this new AI tool I found — ToolXYZ"

- Search affiliate page → behind login, cannot verify commission
- Network listing found on ShareASale → 15% recurring, cookie not specified
- Mark cookie_days as "unverified", note ShareASale default is typically 30 days
- Pricing page → $19/mo and $49/mo plans
- Flag in output: "Commission verified via ShareASale listing. Cookie duration unverified."
- Proceed with listing, clearly marking unverified fields

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — listing data powers review articles and roundup posts
- `landing-page-creator` (S4) — commission structure and product details feed landing pages
- `comparison-post-writer` (S3) — verified program data for side-by-side comparisons
- `commission-calculator` (S1) — structured commission data for earnings projections
- `viral-post-writer` (S2) — program highlights for social content
- `bonus-stack-builder` (S4) — product knowledge informs bonus design

### Fed By

- `affiliate-program-search` (S1) — discovered programs that need to be listed
- `niche-opportunity-finder` (S1) — high-opportunity niches with programs worth documenting
- `conversion-tracker` (S6) — top-performing programs worth listing for the community

### Feedback Loop

- Community engagement on list.affitor.com (stars, comments) reveals which listing styles
  and description formats drive the most affiliate signups. High-star listings become
  templates for future listings. Low-engagement listings get revised with better earning
  potential data and more specific audience targeting.

```yaml
chain_metadata:
  skill_slug: "list-affitor-program"
  stage: "research"
  timestamp: string
  suggested_next:
    - "affiliate-blog-builder"
    - "comparison-post-writer"
    - "landing-page-creator"
    - "commission-calculator"
```

## Quality Gate

Before marking this skill's output as complete:

1. Every commission number traces to an official source URL
2. The `reward_type` is a valid enum value from the list.affitor.com schema
3. Earning potential math is correct and uses conservative assumptions
4. The description contains all required sections (Opening, Why Promote, Commission Table, Target Audiences, Earning Potential, Why It Converts, Honest Limitations)
5. At least one real limitation is listed — no "this program is perfect" outputs
6. Unverified fields are explicitly flagged, never silently estimated
7. Tags are lowercase, 3-6 items, and relevant to the program's niche

## References

- `references/list-affitor-api.md` — API endpoints and authentication for list.affitor.com
- `shared/references/affiliate-glossary.md` — reward_type definitions and field names
- `shared/references/flywheel-connections.md` — master flywheel connection map
