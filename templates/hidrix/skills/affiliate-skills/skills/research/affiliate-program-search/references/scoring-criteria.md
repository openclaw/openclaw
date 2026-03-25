# Program Scoring Framework

Score each program on 5 dimensions, 1-10 scale.

## 1. Earning Potential (weight: 30%)

Factors:

- Commission percentage (`reward_value` — higher = better)
- Recurring vs one-time (`reward_type`: `cps_recurring`/`cps_lifetime` scores 2+ points higher than `cps_one_time`)
- Product price point (higher price = higher absolute earnings per sale)
- Commission duration (`reward_duration`: lifetime > 12 months > one-time)
- Payout threshold (lower = better, especially for beginners)

Scoring guide:

- 9-10: 30%+ recurring on $50+/mo product, lifetime duration
- 7-8: 20-30% recurring on $20-50/mo, 12+ months
- 5-6: 15-20% recurring or $100+ one-time
- 3-4: 10-15% or low-price products
- 1-2: <10%, one-time, low-price

## 2. Content Potential (weight: 25%)

How easy is it to create compelling content about this product?

Factors:

- Does the product have a visual "wow" demo? (AI video, design tools = high)
- Can you show before/after results?
- Is there a free tier or free trial for audience to try?
- Are there multiple content angles? (tutorial, comparison, review, use case)
- Does content about this product tend to get engagement?

Scoring guide:

- 9-10: Visual product, free tier, 5+ content angles, viral potential
- 7-8: Good demo potential, free trial, 3+ content angles
- 5-6: Decent content angles but not visually exciting
- 3-4: Hard to demo, abstract product, limited angles
- 1-2: Boring product, no free tier, only 1 content angle

## 3. Market Demand (weight: 20%)

Is there active demand for this type of product?

To assess: `web_search` for "[product category] tools" and note the result count and recency.

Factors:

- Search volume for product category keywords
- Trend direction (growing, stable, declining)
- Market size (how many potential buyers exist)
- Urgency of need (must-have vs nice-to-have)

Scoring guide (use `web_search "[category] tools"` result count as primary signal):

- 9-10: >100M results, multiple recent articles (<30 days), trending on Google Trends ↑20%+ YoY
- 7-8: 10M-100M results, recent articles (<90 days), stable or growing trend
- 5-6: 1M-10M results, some articles in last 6 months, stable trend
- 3-4: 100K-1M results, few recent articles, flat or declining trend
- 1-2: <100K results, no recent coverage, clearly declining

**Evidence format**: Always show: `"Market Demand X/10 — '[search query]' → [N] results, Trends [↑/↓/→]X% YoY"`
**Confidence**: 🟢 HIGH (Google Trends data available) | 🟡 MEDIUM (result count only) | 🔴 LOW (no reliable signal)

## 4. Competition Level (weight: 15%)

How many other affiliates are promoting this? INVERSE scoring: less competition = higher score.

To assess: `web_search` for "[product] review" — count results and check who ranks in top 10.

Factors:

- Number of existing review articles ranking on Google
- How many YouTubers/creators already cover this product
- Are there dominant affiliates with huge audiences?
- Is the affiliate program new or established?

Scoring guide (use `web_search "[product name] review"` result count + top 10 analysis):

- 9-10: <50K results for "[product] review", top 10 has no major publishers (Forbes, Wirecutter, etc.)
- 7-8: 50K-500K results, top 10 has 1-2 major publishers but indie sites also rank
- 5-6: 500K-5M results, top 10 is mix of major and indie, differentiation needed
- 3-4: 5M-50M results, top 10 dominated by authority sites, hard to rank
- 1-2: >50M results, top 10 is all Forbes/Wirecutter/CNET, near-impossible to rank

**Evidence format**: Always show: `"Competition X/10 — '[product] review' → [N] results, top 10: [brief who ranks]"`
**Confidence**: 🟢 HIGH (reviewed top 10 results) | 🟡 MEDIUM (result count only) | 🔴 LOW (no search performed)

## 5. Trust Factor (weight: 10%)

Is this a quality product you can recommend with integrity?

Factors:

- Product reviews and reputation (G2, Capterra, Trustpilot)
- Company track record and funding
- User retention (do people actually keep using it?)
- Stars on list.affitor.com (`stars_count` — community signal)
- Red flags? (layoffs, pivot, quality decline, data breaches)

Scoring guide (use G2/Capterra rating as primary signal when available):

- 9-10: G2/Capterra ≥4.5/5, `stars_count` ≥20, funded company, no red flags
- 7-8: G2/Capterra 4.0-4.4/5, `stars_count` ≥10, generally positive sentiment
- 5-6: G2/Capterra 3.5-3.9/5, `stars_count` ≥5, some known limitations
- 3-4: G2/Capterra 3.0-3.4/5, `stars_count` <5, mixed reviews or concerning signals
- 1-2: G2/Capterra <3.0/5 or no reviews, red flags (data breach, mass layoffs, pivot)

**Evidence format**: Always show: `"Trust X/10 — G2: [rating]/5 ([N] reviews), stars_count: [N], [any flags]"`
**Confidence**: 🟢 HIGH (G2/Capterra data found) | 🟡 MEDIUM (only stars_count or Trustpilot) | 🔴 LOW (no review data)

## Overall Score Calculation

```
overall = (earning × 0.30) + (content × 0.25) + (demand × 0.20)
        + (competition × 0.15) + (trust × 0.10)
```

## Verdict

- **7.5+: "Strong Pick"** — recommend promoting, high confidence
- **5.5-7.4: "Worth Testing"** — try with small content investment, see results
- **<5.5: "Skip"** — better options available, don't waste effort
