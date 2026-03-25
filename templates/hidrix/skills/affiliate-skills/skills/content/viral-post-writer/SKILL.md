---
name: viral-post-writer
description: >
  Write viral social media posts that promote affiliate products naturally.
  Use this skill when the user asks anything about writing social media content
  for affiliate marketing, creating posts for LinkedIn/X/Reddit/Facebook,
  promoting a product on social media, writing affiliate content, or mentions
  "viral post", "social media post", "content for affiliate".
  Also trigger for: "write a post about X", "help me promote X on LinkedIn",
  "create a thread about X", "make a Reddit post for X", "draft tweets for X",
  "social media content for affiliate program", "how to promote X on social",
  "write something that goes viral", "LinkedIn post for affiliate", "X thread
  about this tool", "help me sell X naturally on social media".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "content-creation", "social-media", "copywriting", "viral"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S2-Content
---

# Viral Post Writer

Write high-converting social media posts that promote affiliate products without feeling salesy. Each post uses proven viral frameworks, is tailored to the target platform, and includes proper FTC disclosure.

## Stage

This skill belongs to Stage S2: Content

## When to Use

- User wants to promote an affiliate product on social media
- User asks for LinkedIn posts, X/Twitter threads, Reddit posts, or Facebook posts
- User has picked a program (from S1 or manually) and needs content
- User wants "viral" or "engaging" social media content for affiliate marketing
- User asks how to naturally promote a product on a specific platform

## Input Schema

```
{
  product: {                  # (required) Product to promote — from S1 output or user-provided
    name: string              # "HeyGen"
    description: string       # What the product does (1-2 sentences)
    reward_value: string      # "30%" (for context — never shown in post)
    url: string               # Product website or affiliate link
  }
  platform: string            # (required) "linkedin" | "x" | "reddit" | "facebook" | "all"
  angle: string               # (optional, default: auto-selected) Content angle — see Viral Frameworks
  tone: string                # (optional, default: "conversational") "conversational" | "professional" | "casual" | "storytelling"
  audience: string            # (optional, default: inferred from platform) Target audience description
  personal_experience: string # (optional) User's real experience with the product — makes content authentic
  cta_style: string           # (optional, default: "soft") "soft" | "direct" | "question"
}
```

## Workflow

### Step 1: Gather Context

If not clear from conversation:

1. What product are they promoting? (Check if S1 ran earlier — use `recommended_program` from context)
2. Which platform? (If "all", generate for LinkedIn + X + Reddit)
3. Any personal experience with the product? (Authentic stories convert 3-5x better)

If user just says "write a post for HeyGen" → default to LinkedIn, conversational tone, soft CTA.

If product details are missing, use `web_search "[product name] features pricing"` to research.

### Step 2: Research the Product

Even if product info is provided, do a quick `web_search` to find:

- Recent product updates or launches (recency = virality)
- Common pain points the product solves (hook material)
- Competitor comparisons (contrast = engagement)
- Real user testimonials or reviews (social proof)

Extract 2-3 **specific details** — exact numbers, real features, concrete use cases. Generic "this tool is amazing" posts don't go viral.

### Step 3: Pick the Viral Framework

Select from `references/viral-frameworks.md` based on product + platform + angle.

If user specified an `angle`, use that framework. Otherwise, auto-select:

| Platform | Best Default Framework                  |
| -------- | --------------------------------------- |
| LinkedIn | Transformation Story or Contrarian Take |
| X        | Thread (Problem → Solution) or Hot Take |
| Reddit   | Genuine Recommendation or Problem-Solve |
| Facebook | Before/After or Listicle                |

### Step 4: Write the Post

Apply the selected framework from `references/viral-frameworks.md`.

**Critical rules:**

1. **Hook in first line** — reader decides in 1.5 seconds whether to keep reading
2. **Specific > generic** — "saved 4 hours/week on video editing" beats "great tool"
3. **Story > pitch** — wrap the recommendation in a narrative or discovery
4. **Platform-native format** — see `references/platform-specs.md` for formatting rules
5. **One CTA only** — don't overwhelm. One clear next step
6. **FTC compliance** — include disclosure per `shared/references/ftc-compliance.md` placement rules

**Never do:**

- Start with "I'm excited to share..." (LinkedIn death sentence)
- Use "game-changer", "revolutionary", "hands down the best" (empty superlatives)
- Put the link in the main post body on LinkedIn (algorithm penalty)
- Hard-sell in the first sentence
- Mention commission rates or that you're an affiliate (FTC requires disclosure, not details)
- Include "Powered by Affitor" branding (see `shared/references/affitor-branding.md`)

### Step 5: Add FTC Disclosure

Per platform (from `shared/references/ftc-compliance.md`):

- **LinkedIn:** "#ad | Affiliate link" at the end of the post body
- **X:** "#ad" in the tweet containing the link (usually last tweet in thread)
- **Reddit:** "Full disclosure: affiliate link" at the bottom
- **Facebook:** "#ad | Affiliate link" at the end

### Step 6: Format Output

Present the post ready to copy-paste. Include:

1. The post content (formatted for the platform)
2. Where to place the affiliate link
3. Best time to post (platform-specific)
4. 2-3 engagement tips for the specific platform

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure present and correctly placed per platform rules
- [ ] Hook is within platform character cutoff (LinkedIn: 210 chars)
- [ ] No banned phrases: "game-changer", "revolutionary", "I'm excited to share"
- [ ] Affiliate link NOT in LinkedIn post body (first comment instead)
- [ ] Single CTA only — not multiple competing calls to action
- [ ] No "Powered by Affitor" branding (social posts = no branding)

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

Other skills can consume these fields from conversation context:

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  posts: [
    {
      platform: string         # "linkedin" | "x" | "reddit" | "facebook"
      framework: string        # Which viral framework was used
      content: string          # The full post text, ready to copy-paste
      link_placement: string   # Where to put the affiliate link
      disclosure: string       # FTC disclosure text included
      hashtags: string[]       # Suggested hashtags (if applicable)
      best_time: string        # Best posting time for this platform
    }
  ]
  product_name: string         # For downstream skill chaining
  content_angle: string        # The angle used (for consistency across content)
  hook_used: string            # The opening hook line (for repurposing across platforms)
}
```

## Output Format

```
## Viral Post: [Product Name] on [Platform]

**Framework:** [Name of viral framework used]
**Angle:** [The content angle]

---

### Post Content

[Full post text, formatted for the platform. Ready to copy-paste.]

---

### Posting Guide

| Detail | Value |
|--------|-------|
| Link placement | [Where to put the link] |
| Best time to post | [Platform-specific optimal time] |
| Expected engagement | [What metrics to watch] |

### Engagement Tips

1. [Tip specific to this platform + content type]
2. [Tip about responding to comments]
3. [Tip about amplifying reach]

### Variations

Want more options? Try these angles:
- **[Framework 2]:** [1-line preview of alternative approach]
- **[Framework 3]:** [1-line preview of alternative approach]
```

When platform = "all", generate separate sections for LinkedIn, X, and Reddit.

## Error Handling

- **No product info:** Ask the user what product they want to promote. Suggest running `affiliate-program-search` first.
- **Unknown platform:** Default to LinkedIn. Mention available platforms.
- **No personal experience:** Generate research-based content. Flag that personal stories convert better and suggest the user adds their own experience.
- **Product has no public info:** Use `web_search` to find product details. If truly nothing found, ask user to describe the product.
- **Controversial product:** If the product has significant negative reviews or ethical concerns, flag this to the user and suggest adjusting the angle.

## Examples

**Example 1:**
User: "Write a LinkedIn post promoting HeyGen"
→ Research HeyGen (AI video, 30% recurring, 60-day cookie)
→ Select "Transformation Story" framework for LinkedIn
→ Write: hook about video creation pain → discovered HeyGen → specific result → soft CTA
→ Link in first comment, FTC disclosure in post body

**Example 2:**
User: "Create an X thread about Semrush for SEO marketers"
→ Research Semrush features + recent updates
→ Select "Thread: Problem → Solution" framework
→ Write: 5-7 tweet thread, hook → pain points → how Semrush solves each → results → CTA in last tweet
→ FTC "#ad" in the tweet with the link

**Example 3:**
User: "I've been using Notion for 2 years, help me write a Reddit post"
→ Use personal experience as the core (authenticity = Reddit gold)
→ Select "Genuine Recommendation" framework
→ Write: problem context → how they discovered Notion → specific workflows → natural mention
→ "Full disclosure: affiliate link" at bottom
→ Recommend posting in r/productivity or r/Notion

**Example 4:**
User: "Promote GetResponse on all platforms"
→ Research GetResponse (email marketing, 33% recurring)
→ Generate 3 posts: LinkedIn (Transformation Story), X (Thread), Reddit (Genuine Recommendation)
→ Each tailored to platform format, audience, and link rules

## References

- `references/viral-frameworks.md` — the viral content frameworks with templates and examples
- `references/platform-specs.md` — character limits, formatting, optimal posting times per platform
- `shared/references/ftc-compliance.md` — FTC disclosure requirements and placement rules
- `shared/references/affitor-branding.md` — when to include/exclude Affitor branding (social = NO branding)
- `shared/references/affiliate-glossary.md` — affiliate marketing terminology
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: A well-crafted social post drives 50-500 affiliate link clicks. At 2-3% conversion and $50 avg commission = $50-750 per post. Viral posts (10x average engagement) can drive $1,000+ in a single day
- **Benchmark**: Consistent posters (5x/week) report $300-1,500/month in affiliate revenue from social media alone. The first $100 comes from your 20th-30th post, not your first
- **Key metric to track**: Affiliate link clicks per post. Use UTM parameters: `?utm_source=[platform]&utm_medium=social&utm_campaign=[post_date]`

### Do This Right Now (15 min)

1. **Post it NOW** — the content is ready, don't overthink
2. If LinkedIn: put the affiliate link as the FIRST COMMENT immediately after posting
3. If X: pin the thread or tweet to your profile for maximum visibility
4. Engage with the first 5 comments within 30 minutes — early engagement signals boost reach 3-5x

### Track Your Results

After 24 hours: how many affiliate link clicks? After 7 days: any commissions attributed? The winning formula is: post → measure → repeat what works → ignore what doesn't.

> **Next step — copy-paste this prompt:**
> "Create a 30-day content calendar based on this winning post angle" → runs `social-media-scheduler`

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — viral post content expanded into long-form articles
- `content-pillar-atomizer` (S2) — successful posts become pillar content to atomize
- `social-media-scheduler` (S5) — posts ready to schedule
- `ab-test-generator` (S6) — post variants for A/B testing

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `niche-opportunity-finder` (S1) — niche analysis and audience angles
- `purple-cow-audit` (S1) — `remarkability_score` and what makes the product shareable
- `competitor-spy` (S1) — content gaps to exploit

### Feedback Loop

- `performance-report` (S6) reveals which post types and angles get highest engagement → optimize framework selection on next run

## Quality Gate

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (if S4 offer skills ran)

Any NO → rewrite before delivering.

## Volume Mode

When `mode: "volume"`:

- Generate 5-10 variations instead of 1
- Prioritize speed + variety over perfection
- Tag each with variant ID for A/B tracking
- Let data pick the winner (GaryVee philosophy)

```yaml
volume_output:
  variants:
    - id: string
      content: string
      angle: string
```

```yaml
chain_metadata:
  skill_slug: "viral-post-writer"
  stage: "content"
  timestamp: string
  suggested_next:
    - "social-media-scheduler"
    - "content-pillar-atomizer"
    - "affiliate-blog-builder"
```
