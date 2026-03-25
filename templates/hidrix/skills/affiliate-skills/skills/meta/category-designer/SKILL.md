---
name: category-designer
description: >
  Define a new category where your product wins by default. Reframe the buying decision.
  Triggers on: "create a category", "category design", "define my category",
  "category of one", "reframe the market", "position as category king",
  "new category", "category creation", "own a category", "category strategy",
  "competitive positioning", "strategic positioning", "market reframing",
  "be the only option", "change the buying criteria", "category king".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "meta", "planning", "compliance", "category-design", "positioning"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S8-Meta
---

# Category Designer

Define a new category where your recommended product wins by default. Instead of competing on existing criteria ("best AI video tool"), reframe the buying decision so your product IS the category ("the AI avatar platform for non-creators"). Category kings capture 76% of category economics — this is the strategic meta-skill that makes all downstream marketing easier.

## Stage

S8: Meta — This is cross-cutting strategic thinking, like `funnel-planner`. It operates above individual skills and reframes the entire marketing approach. Use it before creating content, offers, or landing pages.

## When to Use

- User is competing in a crowded market and needs to stand out
- User asks about "positioning", "category", "differentiation", "reframing"
- User says "category of one", "own a category", "change the game"
- After `monopoly-niche-finder` to formalize the niche into a named category
- After `purple-cow-audit` to amplify what makes a product remarkable
- Before creating content/offers to ensure consistent category messaging

## Input Schema

```yaml
product: object               # REQUIRED — the product to position
  name: string
  description: string
  key_features: string[]
  pricing: string
  current_category: string    # What category it's currently in
                              # e.g., "AI video tools", "email marketing platforms"

competitors: string[]         # OPTIONAL — main competitors
                              # Default: auto-researched

your_audience: string         # OPTIONAL — your specific audience
                              # Default: inferred from product

monopoly_niche: string        # OPTIONAL — from monopoly-niche-finder
                              # Default: none
```

**Chaining from S1 monopoly-niche-finder**: Use `monopoly_niche.intersection` as the starting point for category design.

**Chaining from S1 purple-cow-audit**: Use `remarkable_angles` to identify category-defining features.

## Workflow

### Step 1: Analyze Current Category

1. `web_search`: `"best [current_category]"` — see how the market is currently framed
2. Identify the default buying criteria (price, features, ease of use, etc.)
3. Map where the product wins AND loses on current criteria
4. Identify: what does this product do that competitors DON'T even try?

### Step 2: Find the Category Seed

The category seed is the intersection of:

- What the product does uniquely well
- What a specific audience cares about most
- What competitors ignore or can't do

Formula: `[Unique capability] + [Specific audience] + [Outcome they care about]`

Example: "AI avatar platform" + "for non-creators" + "who need professional video content"
= **"AI Video Content Platform for Non-Creators"**

### Step 3: Design the Category

Define:

1. **Category name** — 3-6 words, self-explanatory, memorable
2. **Category POV** — "The old way was [X]. The new way is [Y]. [Product] is the [category name]."
3. **Buying criteria** — new criteria where your product automatically wins
4. **Lightning strike** — the "aha moment" that makes the category real (a stat, story, or demonstration)
5. **Category ecosystem** — what other products/services exist in YOUR category (you define the landscape)

### Step 4: Create Category Assets

Produce:

1. **Category narrative** — 2-3 paragraph story of why this category exists now
2. **Comparison reframe** — how to redirect "Product X vs Product Y" to "Old category vs New category"
3. **Content angles** — 5-10 content pieces that educate the market about the category
4. **Objection handling** — "Isn't this just [old category]?" → "No, because..."

### Step 5: Self-Validation

- [ ] Category name is self-explanatory to someone hearing it for the first time
- [ ] Product genuinely wins on the new buying criteria (not forced)
- [ ] Category is big enough to matter but specific enough to own
- [ ] Narrative is compelling and truthful (not spin)
- [ ] Content angles are substantial enough for 6+ months of content

## Output Schema

```yaml
output_schema_version: "1.0.0"
category:
  name: string                  # The new category name
  pov: string                   # Point of view statement
  product_name: string
  old_category: string          # What it was before
  buying_criteria: string[]     # New criteria where product wins
  lightning_strike: string      # The "aha" proof point

  narrative: string             # Category story (2-3 paragraphs)
  comparison_reframe: string    # How to redirect comparisons

  content_angles: string[]     # Content pieces that establish the category
  objection_responses: object[] # Objection handling
    - objection: string
      response: string

  category_definition: string  # For chaining — the full category definition
  category_framing: string     # For chaining — positioning statement

chain_metadata:
  skill_slug: "category-designer"
  stage: "meta"
  timestamp: string
  suggested_next:
    - "grand-slam-offer"
    - "monopoly-niche-finder"
    - "affiliate-blog-builder"
    - "landing-page-creator"
```

## Output Format

```
## Category Design: [Category Name]

### The Shift
**Old category:** [what it was]
**New category:** [what it is now]
**Why now:** [why this category exists today]

### Category Definition
**[Category Name]:** [1 sentence definition]

### Point of View
"[The old way] was [X]. [The new way] is [Y]. [Product] is the [category name] that [outcome]."

### New Buying Criteria
When evaluating a [category name], look for:
1. [Criteria where your product wins]
2. [Criteria where your product wins]
3. [Criteria where your product wins]
(Note: [old criteria like "most features"] no longer matters because [reason])

### Lightning Strike
[The stat, story, or demo that makes the category undeniable]

### Category Narrative
[2-3 paragraphs telling the story of this category]

### Comparison Reframe
When someone asks "[Product] vs [Competitor]":
→ Reframe: "That's like comparing [new thing] to [old thing]. The question isn't [old criteria] — it's [new criteria]."

### Content Roadmap
1. "[Title]" — establishes the category problem
2. "[Title]" — introduces the new buying criteria
3. "[Title]" — showcases the product as category king
4. "[Title]" — data/proof that the new way works
5. "[Title]" — community/social proof

### Objection Handling
**"Isn't this just [old category]?"**
→ [Response]

**"Why should I care about a new category?"**
→ [Response]
```

## Error Handling

- **No product provided**: "Tell me the product and its current competitive landscape — I'll design a category it owns."
- **Product has no unique features**: "Every product has something. Let me dig deeper..." → focus on audience specificity rather than feature uniqueness.
- **Category too forced**: If the category feels artificial, recommend improving the product positioning within the existing category instead. Honesty > cleverness.
- **Too many competitors in proposed category**: Narrow the audience further or combine with `monopoly-niche-finder` for a tighter intersection.

## Examples

**Example 1:** "Design a category for HeyGen"
→ Old: "AI video tool." New: "AI Video Content Platform for Non-Creators." Buying criteria: no camera needed, no editing skills, no studio. Lightning strike: "84% of marketers say video is important, but only 15% make it regularly."

**Example 2:** "Position Semrush differently from Ahrefs"
→ Old: "SEO tool." New: "Revenue Intelligence Platform." Buying criteria: revenue attribution, not just rankings. Reframe: "Stop tracking keywords. Start tracking revenue."

**Example 3:** "Create a category for my niche" (after monopoly-niche-finder)
→ Take intersection niche, formalize into a named category with full narrative, buying criteria, and content roadmap.

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Category kings capture 76% of category economics. If you define the category for your niche, your affiliate content becomes the default recommendation. Affiliates who "own" a category report 5-10x higher conversion rates because buyers see them as THE authority, not one of many
- **Benchmark**: Category-defining content gets 3x more organic search traffic because you rank for new keywords nobody else targets. You're not competing for "best AI video tool" — you're ranking for your own category name
- **Key metric to track**: Brand search volume (people searching YOUR category name or your brand + product) and affiliate conversion rate. Category owners see 5-8% conversion vs 1-2% for generic affiliates

### Do This Right Now (15 min)

1. **Publish your first category-defining content piece** — use Content Angle #1 from the Content Roadmap
2. **Update your social bios** to include the category name (e.g., "Helping non-creators make professional videos | AI Video Content for Non-Creators")
3. **Update your landing page hero** with the Category POV statement
4. **Start using the category name consistently** in all content — repetition creates recognition

### Track Your Results

After 90 days: are people using your category name in conversations, searches, or social posts? After 6 months: has your affiliate conversion rate increased vs before category positioning? Category design is a long game — it compounds over months, not days.

> **Next step — copy-paste this prompt:**
> "Build an irresistible offer for [product] using this category positioning: [category POV]" → runs `grand-slam-offer`

## Flywheel Connections

### Feeds Into

- `grand-slam-offer` (S4) — category framing becomes the offer's core positioning
- `monopoly-niche-finder` (S1) — category definition sharpens niche targeting
- `landing-page-creator` (S4) — category narrative for landing page hero
- `affiliate-blog-builder` (S3) — content angles for category-establishing articles
- `viral-post-writer` (S2) — category POV for shareable social content

### Fed By

- `monopoly-niche-finder` (S1) — niche to formalize into a category
- `purple-cow-audit` (S1) — remarkable features that define the category
- `competitor-spy` (S1) — competitive landscape to differentiate from

### Feedback Loop

- `performance-report` (S6) tracks which category messaging resonates → refine category name and POV based on engagement data

## References

- `shared/references/affiliate-glossary.md` — Terminology
- `shared/references/case-studies.md` — Real positioning examples
- `shared/references/flywheel-connections.md` — Master connection map
