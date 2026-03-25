---
name: content-repurposer
description: >
  Repurpose one piece of affiliate content into multiple formats. Triggers on:
  "repurpose my content", "turn my blog into tweets", "cross-post this",
  "content recycling", "convert to newsletter", "make a tweet thread from this",
  "adapt for TikTok", "omnichannel content", "scale my content",
  "turn this into a LinkedIn post", "repurpose for email", "content multiplication".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "automation", "scaling", "workflow", "repurposing", "multi-format"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S7-Automation
---

# Content Repurposer

Repurpose one piece of affiliate content into multiple formats — blog post to tweets, landing page to email, video script to blog, social post to newsletter. Each output is adapted to the target platform's rules, tone, length, and FTC requirements. Output is a set of ready-to-post content blocks.

## Stage

S7: Automation — Creating content from scratch is expensive. The fastest way to scale is to repurpose what already works. One blog post can become 5 tweets, 1 LinkedIn post, 1 Reddit post, and 2 emails — multiplying your reach without multiplying your effort.

## When to Use

- User has existing content and wants it on more platforms
- User says "turn my blog into tweets" or "repurpose this for LinkedIn"
- User wants to scale content distribution without writing from scratch
- User says "cross-post", "content recycling", "omnichannel"
- User has a winning piece and wants to maximize its ROI
- Chaining from S2-S5: take any content output and adapt it for additional platforms

## Input Schema

```yaml
source_content: string # REQUIRED — the original content (full text, or from conversation)

source_type:
  string # REQUIRED — "blog" | "social" | "landing" | "email"
  # | "video_script" | "newsletter"

target_formats: # REQUIRED — formats to repurpose into
  - string # "tweet_thread" | "linkedin_post" | "tiktok_script"
    # | "newsletter" | "reddit_post" | "email"
    # | "blog_summary" | "pinterest_pin"

product:
  name: string # OPTIONAL — product being promoted
  affiliate_url: string # OPTIONAL — affiliate link to include in each format
```

**Chaining context**: If S2-S5 content was generated in the same conversation, reference it directly: "repurpose my blog post for Twitter and LinkedIn."

## Workflow

### Step 1: Analyze Source Content

Extract from the source:

- **Core value proposition**: The main benefit or insight
- **Key hooks**: Attention-grabbing statements or data points
- **Proof points**: Statistics, testimonials, personal experience
- **CTA**: The action the reader should take
- **Affiliate link**: The link to preserve in all formats

### Step 2: Map to Target Formats

For each target format, define constraints:

- **Tweet thread**: 5-10 tweets, 280 chars each, hook in tweet 1, CTA + link in last tweet
- **LinkedIn post**: 1,300 chars max for full visibility, professional tone, no link in body (comments)
- **TikTok script**: 30-60 seconds, spoken word, hook in first 3 seconds, CTA at end
- **Newsletter**: 500-800 words, subject line + preview, value-first structure
- **Reddit post**: Authentic tone, value-first, disclosure at bottom, suggest subreddit
- **Email**: Subject + preview + body + CTA, 200-300 words
- **Blog summary**: 300-500 words condensed version with key points
- **Pinterest pin**: Title (40 chars), description (500 chars), image text suggestion

### Step 3: Adapt Content

For each target format:

1. Select the most relevant hooks and proof points
2. Rewrite in the platform's native voice and format
3. Adjust length to platform norms
4. Place affiliate link according to platform best practices
5. Add platform-appropriate FTC disclosure

### Step 4: Add Platform-Specific Posting Guides

For each output, include:

- Best time to post (general guidance)
- Hashtag strategy (if applicable)
- Engagement tips specific to the platform
- Link placement rules

### Step 5: Output All Variants

Present each format as a separate, clearly labeled block ready to copy and paste.

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] Each format is adapted to its platform (not copy-pasted across formats)
- [ ] Character counts are within platform limits
- [ ] FTC disclosure present in every variant that contains affiliate link
- [ ] Core value proposition preserved across all repurposed formats
- [ ] Affiliate link placement follows platform-specific rules

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
repurposed:
  source_type: string
  source_summary: string # one-sentence summary of original
  formats_generated: number

outputs:
  - format: string # target format name
    content: string # the repurposed content (ready to post)
    platform: string # which platform this is for
    character_count: number
    affiliate_link_placement: string # where the link goes
    disclosure: string # FTC disclosure used
    posting_guide:
      best_time: string
      hashtags: string[]
      tips: string[]
```

## Output Format

1. **Source Summary** — one paragraph describing the original content
2. **Repurposed Content** — each format as a separate block with clear headers
3. **Posting Guide** — per-format tips for best results
4. **Affiliate Link Summary** — which formats include the link and where

## Error Handling

- **Source content too short (<100 words)**: "The source content is quite short. I'll work with what's here, but longer source content produces better repurposed variants. Consider using the full blog post rather than just the intro."
- **No affiliate link**: "I'll repurpose the content without an affiliate link. Add `[YOUR_AFFILIATE_LINK]` where I've marked the CTA before posting."
- **Incompatible format**: "Converting a tweet to a blog post is more like 'expanding' than 'repurposing.' Use S3 (affiliate-blog-builder) to write a full blog post around this topic instead."

## Examples

### Example 1: Blog to social media

**User**: "Turn my HeyGen review blog post into a tweet thread and LinkedIn post"
**Action**: Extract key points from the blog (top 5 features, pricing, verdict). Tweet thread: Hook tweet → 5 feature tweets with mini-takes → verdict tweet → CTA tweet with link + #ad. LinkedIn post: Professional angle (time savings, ROI), personal experience tone, link in first comment, #ad disclosure.

### Example 2: Landing page to email

**User**: "Repurpose my Semrush landing page into a 3-email sequence"
**Action**: Extract value proposition, benefits, social proof, CTA from landing page. Email 1: Problem awareness (pain point from landing page). Email 2: Solution introduction (benefits). Email 3: CTA (affiliate link + urgency from landing page). Each email under 300 words.

### Example 3: Social post to newsletter

**User**: "My LinkedIn post about AI tools got 500 likes. Turn it into a newsletter."
**Action**: Expand the LinkedIn post's hook into a newsletter intro. Add depth: examples, data, personal experience that couldn't fit in 1,300 chars. Structure: Hook → context → 3 insights → recommendation → CTA. Include FTC disclosure and affiliate link.

## References

- `shared/references/ftc-compliance.md` — Per-platform FTC disclosure rules. Read in Step 3.
- `shared/references/affitor-branding.md` — Branding guidelines for page outputs. Referenced in Step 3.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Repurposing multiplies the revenue of a single piece of content across platforms. One winning blog post repurposed to 5 platforms = 5x more affiliate link exposure. If the original blog earns $200/month, repurposed versions can add $100-500/month from new traffic sources
- **Benchmark**: The best-performing repurposed format is usually email (highest CTR, 2-5%) and LinkedIn (highest professional engagement). Reddit drives the highest conversion rate (3-5%) but lowest volume
- **Key metric to track**: Affiliate link clicks per repurposed format. Which platform sends the most clicks per piece of content?

### Do This Right Now (15 min)

1. **Post the highest-potential repurposed piece immediately** — usually the LinkedIn or X version (fastest engagement)
2. **Schedule the rest** across the next 5-7 days — one platform per day to maximize algorithm reach
3. **Add UTM parameters** to every affiliate link: `?utm_source=[platform]&utm_medium=repurpose&utm_campaign=[original_title]`
4. **Bookmark the original** — if any repurposed version goes viral, create more content on that angle

### Track Your Results

After 14 days: which repurposed format drove the most affiliate clicks? Focus your repurposing effort on that format first in the future. Kill formats that consistently get zero clicks — not every platform works for every niche.

> **Next step — copy-paste this prompt:**
> "Schedule all my repurposed content for the next 30 days" → runs `social-media-scheduler`

## Flywheel Connections

### Feeds Into

- `content-pillar-atomizer` (S2) — repurposed content to atomize further
- `social-media-scheduler` (S5) — repurposed content to schedule

### Fed By

- `affiliate-blog-builder` (S3) — blog articles to repurpose
- `landing-page-creator` (S4) — landing page copy to repurpose into emails
- `performance-report` (S6) — identifies top-performing content worth repurposing

### Feedback Loop

- `performance-report` (S6) shows which repurposed formats perform best → prioritize those formats

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
  skill_slug: "content-repurposer"
  stage: "automation"
  timestamp: string
  suggested_next:
    - "content-pillar-atomizer"
    - "social-media-scheduler"
```
