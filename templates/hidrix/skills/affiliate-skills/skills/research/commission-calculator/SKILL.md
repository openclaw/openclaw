---
name: commission-calculator
description: >
  Calculate realistic affiliate earnings projections before committing to a program.
  Use this skill when the user asks about affiliate earnings, projecting income,
  calculating commissions, estimating how much they can make, comparing program
  payouts, or says "how much can I make promoting X", "calculate my affiliate income",
  "is this commission worth it", "how long to first $1000", "compare earnings
  between programs", "traffic to income calculator", "what conversion rate should
  I expect", "earnings estimate for affiliate program", "how many sales do I need".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "research",
    "niche-analysis",
    "program-discovery",
    "commission",
    "revenue",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Commission Calculator

Project realistic monthly affiliate earnings based on traffic estimates, platform
conversion rates, and program commission structures. Helps affiliates decide which
programs are worth their time before investing months of content creation.

## Stage

This skill belongs to Stage S1: Research

## When to Use

- User wants to project income before choosing a program
- User wants to compare the earnings potential of 2+ programs
- User is setting income goals and needs realistic benchmarks
- User is deciding whether a niche is worth entering based on earning potential
- User asks "how many page views / subscribers / followers do I need to make X"

## Input Schema

```
{
  programs: [
    {
      name: string            # (required) "HeyGen"
      reward_value: string    # (required) "30%" or "$50"
      reward_type: string     # (required) "cps_recurring" | "cps_one_time" | "cpl" | "cpa"
      reward_duration: string # (optional) "12 months" | "lifetime" | "first purchase"
      cookie_days: number     # (optional, default: 30) 30
      avg_product_price: number # (optional) Monthly plan price in USD. Needed for % commissions
    }
  ]
  traffic: {
    monthly_visitors: number  # (optional) Estimated monthly website visitors or video views
    email_subscribers: number # (optional) Email list size
    social_followers: number  # (optional) Followers on primary platform
  }
  platform: string            # (optional) "blog" | "youtube" | "tiktok" | "email" | "twitter"
  scenario: string            # (optional, default: "realistic") "conservative" | "realistic" | "optimistic"
  goal: string                # (optional) Target income, e.g., "$500/mo" or "$1000/mo"
  time_horizon: string        # (optional, default: "90 days") "30 days" | "90 days" | "12 months"
}
```

## Workflow

### Step 1: Gather Program Details

If program details are missing, pull from list.affitor.com (see `references/list-affitor-api.md`).

Key fields to extract: `reward_value`, `reward_type`, `cookie_days`.

If `avg_product_price` is not provided and `reward_type` is percentage-based, estimate it:

- Use `web_search "[program name] pricing"` to find the most common paid plan price
- For SaaS: use the mid-tier plan (e.g., $49/mo on a $19/$49/$99 structure)
- Note the assumption in output so user can adjust

For `cps_recurring` programs, establish payout duration:

- "Lifetime" = commissions paid as long as customer stays (most valuable)
- "12 months" = commissions paid for customer's first year
- "First purchase only" = functionally the same as one-time despite being subscription

### Step 2: Gather Traffic Estimates

If traffic data is not provided, prompt the user OR use platform benchmarks:

| Channel                         | Benchmark Ranges            |
| ------------------------------- | --------------------------- |
| New blog (0-6 months)           | 500-2,000 visitors/mo       |
| Growing blog (6-18 months)      | 2,000-20,000 visitors/mo    |
| Established blog (18+ months)   | 20,000-200,000+ visitors/mo |
| YouTube channel (<1K subs)      | 200-2,000 views/mo          |
| YouTube channel (1K-10K subs)   | 2,000-50,000 views/mo       |
| TikTok (<10K followers)         | 1,000-20,000 views/video    |
| Twitter/X (<5K followers)       | 50-500 impressions/tweet    |
| Email list (<1K subscribers)    | 200-400 opens/send          |
| Email list (1K-10K subscribers) | 2,000-7,000 opens/send      |

If user won't provide traffic, use "realistic" scenario benchmarks for their stated
platform and growth stage.

### Step 3: Apply Conversion Rate Assumptions

Use these industry-standard conversion rates as defaults. Adjust based on traffic quality
("buyer intent" content converts 5-10x better than informational content):

| Platform + Content Type         | Click-through Rate | Affiliate Conversion |
| ------------------------------- | ------------------ | -------------------- |
| Blog — product review           | 3-6%               | 2-5%                 |
| Blog — best-of listicle         | 1.5-3%             | 1-3%                 |
| Blog — tutorial/how-to          | 0.5-1.5%           | 0.5-2%               |
| YouTube — dedicated review      | 5-10%              | 3-6%                 |
| YouTube — tutorial with mention | 1-3%               | 1-3%                 |
| TikTok — product demo           | 0.5-2% (bio link)  | 0.5-2%               |
| Email — dedicated send          | 10-20%             | 3-8%                 |
| Twitter/X — thread CTA          | 0.5-2%             | 0.5-2%               |

For scenario multipliers:

- Conservative: use lower bound of each range
- Realistic: use midpoint
- Optimistic: use upper bound

### Step 4: Calculate Monthly and Projected Earnings

**Formula:**

```
Monthly clicks = Monthly visitors × Click-through rate
Monthly conversions = Monthly clicks × Affiliate conversion rate
Monthly commission = Monthly conversions × Commission per sale

Commission per sale:
  - Percentage-based: avg_product_price × (reward_value / 100)
  - Fixed: reward_value (as number)

For recurring (monthly SaaS) over time_horizon:
  Month 1 revenue = Month 1 conversions × commission_per_sale
  Month 2 revenue = (Month 1 conversions + Month 2 conversions) × commission_per_sale
  Month N = sum of all active subscribers × commission_per_sale
  [Cap at reward_duration if not lifetime]
```

Calculate for each program:

- Monthly commission at current traffic
- Cumulative commission at 30, 90, 180, 365 days
- Visitors needed to hit user's income goal (if provided)
- Time to first commission (assuming current traffic growth)

### Step 5: Side-by-Side Comparison (Multiple Programs)

If 2+ programs are provided, produce a comparison table:

- Sort by 12-month projected earnings (highest first)
- Flag programs where recurring vs. one-time makes a dramatic difference
- Call out programs with short cookie windows — lower conversion rates assumed
- Note programs with minimum payout thresholds that could delay first payment

### Step 6: Reverse Calculation (If Goal Provided)

If user states an income goal (e.g., "I want $500/mo"), calculate:

- Visitors/month needed to hit that goal with each program
- Number of sales/leads needed per month
- How long to reach that traffic level (using typical affiliate blog growth curves:
  months 1-6 = slow, months 7-12 = acceleration, year 2 = compounding)

### Step 7: Sanity Check and Context

Add context so user isn't misled by numbers:

1. These are projections, not guarantees. Real results vary significantly.
2. High-quality, buying-intent traffic converts 3-5x better than general traffic.
3. First sales often take 2-3 months even with good traffic (cookie window, indecision).
4. Recurring programs feel slow at first but compound — show the Year 1 vs Year 2 difference.

### Step 8: Self-Validation

Before presenting output, verify:

- [ ] Commission math is correct (% × price × conversions)
- [ ] Recurring compounding calculated correctly over 12 months
- [ ] CTR and conversion rate within industry benchmarks (1-5% CTR, 1-3% CR)
- [ ] Unrealistic goals flagged honestly with required traffic numbers
- [ ] One-time vs recurring distinction clear in projections

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  projections: [
    {
      program_name: string         # "HeyGen"
      reward_type: string          # "cps_recurring"
      commission_per_sale: number  # 14.40 (USD)
      monthly_30d: number          # Estimated month 1 earnings
      monthly_90d: number          # Estimated month 3 earnings
      monthly_12m: number          # Estimated month 12 earnings
      cumulative_12m: number       # Total year 1 earnings
      sales_needed_for_goal: number | null  # If goal provided
      visitors_needed_for_goal: number | null
    }
  ]
  assumptions: {
    monthly_visitors: number
    ctr: number
    conversion_rate: number
    scenario: string
    avg_product_price: number | null
  }
  top_program: string      # Name of highest-earning program at 12 months
  insight: string          # 2-3 sentence key takeaway
}
```

## Output Format

```
## Commission Calculator: [Program(s)]

### Assumptions Used

| Input | Value | Source |
|-------|-------|--------|
| Monthly visitors | [X] | [User-provided / estimated for [platform]] |
| Click-through rate | [X%] | [Platform benchmark — scenario] |
| Affiliate conversion | [X%] | [Platform benchmark — scenario] |
| Product price | $[X]/mo | [User-provided / web research] |
| Scenario | [Conservative / Realistic / Optimistic] | — |

---

### Earnings Projections

| Program | Per Sale | Month 1 | Month 3 | Month 6 | Year 1 Total |
|---------|----------|---------|---------|---------|-------------|
| [Program A] | $[X] | $[X] | $[X] | $[X] | $[X] |
| [Program B] | $[X] | $[X] | $[X] | $[X] | $[X] |

*[Note on recurring vs. one-time difference if applicable]*

---

### To Hit Your Goal of $[X]/mo

| Program | Sales Needed/Mo | Visitors Needed/Mo | Est. Time to Reach |
|---------|----------------|-------------------|-------------------|
| [Program A] | [X] | [X] | [X months] |
| [Program B] | [X] | [X] | [X months] |

---

### Key Insight

[2-3 sentences summarizing which program wins, why recurring compounds so much,
and what realistic first 90 days looks like]

---

## Next Steps

1. Run `affiliate-program-search` to verify these programs are on list.affitor.com
2. Run `niche-opportunity-finder` if you want to compare across niches, not just programs
3. Start creating content — your first sale typically comes at [estimated timeframe]
```

## Error Handling

- **No traffic data provided:** Use conservative benchmarks and label them clearly.
  Ask user for rough estimate ("Do you have any traffic yet, or are you starting from zero?")
- **Commission is percentage but no product price:** Use web_search to estimate.
  If still unknown, run calculator with $50, $100, $200 placeholders and show sensitivity.
- **Program not found on list.affitor.com:** Use web_search to find official affiliate
  program page. Extract commission from there.
- **Unrealistic goal stated (e.g., "$10K/month in 30 days"):** Complete the calculation,
  then honestly flag the traffic required (e.g., "This would require 2M visitors/month —
  more realistic in year 2-3 with consistent publishing.")
- **One-time vs. recurring confusion:** Always clarify the distinction. Show side-by-side
  year 1 earnings for a hypothetical one-time equivalent vs. recurring to illustrate.

## Examples

**Example 1:**
User: "How much can I make promoting HeyGen with a 5,000 visitor/month blog?"
→ Fetch HeyGen data: 30% recurring, 60-day cookie
→ Estimate: $39/mo avg plan × 30% = $11.70/conversion
→ 5,000 visitors × 3% CTR × 3% conversion = 4.5 sales/mo = $52.65/mo at month 1
→ By month 12 (compounding): ~$280/mo steady state
→ Year 1 total: ~$1,890

**Example 2:**
User: "Compare earnings: ConvertKit vs Mailchimp affiliate, I have 2,000 email subscribers"
→ Email channel: 15% open rate, 15% CTR on dedicated send, 5% conversion
→ ConvertKit: $29/mo avg plan, 30% recurring → $8.70/conversion
→ Mailchimp: one-time 20% up to $150 per referral (verify via web_search)
→ Calculate both at 90d and 12m. Show compounding advantage of ConvertKit.

**Example 3:**
User: "I want to make $1,000/month from affiliate marketing, how long will it take?"
→ Ask: what niche/programs? what platform? current traffic?
→ If starting from zero: model blog growth curve (months 1-6 = 0-2K visitors)
→ With realistic programs (30% recurring SaaS): need ~8,000-15,000 visitors/mo
→ Typical timeline: 8-14 months from zero to $1K/mo with consistent publishing

## References

- `references/list-affitor-api.md` — fetch live program data for commission structures
- `shared/references/affiliate-glossary.md` — reward_type definitions
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `funnel-planner` (S8) — commission projections inform funnel ROI estimates
- `value-ladder-architect` (S4) — commission structure shapes ladder design
- `multi-program-manager` (S7) — calculated commissions for portfolio management

### Fed By

- `affiliate-program-search` (S1) — program commission data to calculate
- `multi-program-manager` (S7) — managed programs for portfolio calculation

### Feedback Loop

- `conversion-tracker` (S6) provides actual earnings → compare projected vs actual commissions → improve calculation accuracy

```yaml
chain_metadata:
  skill_slug: "commission-calculator"
  stage: "research"
  timestamp: string
  suggested_next:
    - "funnel-planner"
    - "value-ladder-architect"
    - "landing-page-creator"
```
