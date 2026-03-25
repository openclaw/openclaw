---
name: content-pillar-atomizer
description: >
  Take 1 blog post or article and generate 15-30 platform-native micro-content pieces.
  Not reformatting — re-contextualizing for each platform's culture.
  Triggers on: "atomize this content", "repurpose my blog post", "turn this into social posts",
  "content atomizer", "pillar content", "one to many content", "repurpose content",
  "multiply my content", "content explosion", "turn article into posts",
  "break down this article", "micro content from blog", "content pillar strategy",
  "10x my content", "platform-native content", "atomize", "content multiplication".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "content-creation",
    "social-media",
    "copywriting",
    "content-strategy",
    "repurposing",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S2-Content
---

# Content Pillar Atomizer

Take 1 blog post or article and generate 15-30 platform-native micro-content pieces. This is NOT reformatting — it's re-contextualizing each piece for the platform's culture, format, and audience expectations. A LinkedIn post reads nothing like a Reddit comment, even if they carry the same insight.

## Stage

S2: Content Creation — This IS content creation, just at 10x scale. One piece of deep work becomes a month of social content.

## When to Use

- User has a blog post, article, or long-form content and wants to maximize its reach
- User asks to "repurpose" or "atomize" content
- User says "turn this into social posts", "content multiplication", "pillar content"
- After `affiliate-blog-builder` (S3) produces an article — atomize it into social
- User wants to maintain consistent content output without creating from scratch daily

## Input Schema

```yaml
pillar_content: string        # REQUIRED — the full blog post/article text, or URL to fetch

platforms: string[]           # OPTIONAL — target platforms
                              # Options: "twitter", "linkedin", "reddit", "tiktok", "email", "threads"
                              # Default: ["twitter", "linkedin", "reddit"]

product: object               # OPTIONAL — affiliate product being promoted
  name: string
  url: string
  reward_value: string

mode: string                  # OPTIONAL — "quality" | "volume"
                              # Default: "quality"

tone: string                  # OPTIONAL — "professional" | "casual" | "edgy" | "educational"
                              # Default: inferred from pillar content
```

**Chaining from S3**: If `affiliate-blog-builder` was run, use its output article as `pillar_content`.

**Chaining from S1 monopoly-niche-finder**: Use `monopoly_niche` positioning to angle all micro-content.

## Workflow

### Step 1: Analyze Pillar Content

1. If URL provided, use `web_fetch` to retrieve content
2. Extract: key insights (5-8), data points, quotes, frameworks, stories, opinions
3. Identify the "atomic units" — self-contained ideas that work independently
4. Note the product/affiliate angle (if present)

### Step 2: Platform Mapping

Read `shared/references/platform-rules.md` for platform-specific rules.

For each platform, map the culture:

| Platform  | Format                   | Tone                             | Length                         | CTA Style            |
| --------- | ------------------------ | -------------------------------- | ------------------------------ | -------------------- |
| Twitter/X | Thread or single tweet   | Punchy, opinionated              | 280 chars or 5-10 tweet thread | Last tweet           |
| LinkedIn  | Story or insight post    | Professional, first-person       | 1300 chars                     | Soft CTA in comments |
| Reddit    | Value-first post/comment | Helpful, honest, skeptical-aware | Variable                       | Disclosure + subtle  |
| TikTok    | Script with hook         | Casual, energetic                | 30-60s script                  | Verbal + bio link    |
| Email     | Newsletter section       | Conversational                   | 200-400 words                  | Direct link          |
| Threads   | Conversational take      | Casual, authentic                | 500 chars                      | Bio link             |

### Step 3: Generate Micro-Content

For each platform, generate pieces from different atomic units:

- **Twitter**: 3-5 pieces (1 thread, 2-3 standalone tweets, 1 hot take)
- **LinkedIn**: 2-3 pieces (1 story post, 1 insight post, 1 question post)
- **Reddit**: 2-3 pieces (1 detailed post, 1-2 comment-ready responses)
- **TikTok**: 2-3 scripts (1 educational, 1 hot take, 1 tutorial)
- **Email**: 1-2 pieces (newsletter section, dedicated email)
- **Threads**: 2-3 pieces (conversational takes)

Each piece must:

- Stand alone (makes sense without reading the pillar)
- Feel native to the platform (not a copy-paste resize)
- Carry one clear insight or value point
- Include appropriate FTC disclosure for affiliate content

### Step 4: Tag for Tracking

Tag each piece with:

- Source pillar reference
- Platform
- Content type (thread, single, story, script)
- Affiliate product (if applicable)
- Suggested posting time/day

### Step 5: Self-Validation

- [ ] Each piece feels native to its platform (not copy-pasted)
- [ ] Each piece stands alone without needing the pillar
- [ ] FTC disclosure included where affiliate links present
- [ ] No two pieces on the same platform say the same thing
- [ ] Platform rules followed (Reddit skepticism, LinkedIn professionalism, etc.)

## Output Schema

```yaml
output_schema_version: "1.0.0"
atomized_content:
  pillar_title: string
  total_pieces: number
  platforms_covered: string[]

  pieces:
    - platform: string
      type: string # "thread" | "single" | "story" | "script" | "email" | "comment"
      content: string # The actual content, ready to post
      insight_source: string # Which atomic unit from the pillar
      has_affiliate_link: boolean
      suggested_timing: string # e.g., "Tuesday 9am"
      variant_id: string # For volume mode A/B tracking

  content_pillars: string[] # Atomic units extracted (for chaining)

chain_metadata:
  skill_slug: "content-pillar-atomizer"
  stage: "content"
  timestamp: string
  suggested_next:
    - "social-media-scheduler"
    - "email-drip-sequence"
    - "ab-test-generator"
```

## Output Format

```
## Content Atomizer: [Pillar Title]

### Pillar Analysis
- **Atomic units extracted:** X insights
- **Platforms:** [list]
- **Total pieces generated:** XX

---

### Twitter/X (X pieces)

**Thread: [Title]**
🧵 1/ [first tweet]
2/ [second tweet]
...
[last tweet with CTA]

**Standalone Tweet:**
[tweet text]

---

### LinkedIn (X pieces)

**Story Post:**
[full LinkedIn post]

---

### Reddit (X pieces)

**Post: r/[subreddit]**
Title: [title]
[body with disclosure]

---

[Continue for each platform]

### Posting Schedule
| Day | Platform | Piece | Time |
|---|---|---|---|
| Mon | Twitter | Thread | 9am |
| Tue | LinkedIn | Story | 8am |
| Wed | Reddit | Post | 12pm |
```

## Error Handling

- **No pillar content provided**: "Paste your blog post or article, or give me the URL and I'll fetch it."
- **Content too short**: "This is quite short for atomization. I'll extract what I can, but consider writing a longer pillar first with `affiliate-blog-builder`."
- **No affiliate angle**: Generate content without affiliate links. Pure value content builds audience for future promotions.
- **Platform not supported**: "I don't have specific rules for [platform]. I'll format it generically — review before posting."

## Examples

**Example 1:** "Atomize my HeyGen review blog post into social content"
→ Extract 6 key insights, generate 15 pieces across Twitter (thread + 3 tweets), LinkedIn (2 posts), Reddit (2 posts), TikTok (2 scripts).

**Example 2:** "Turn this article into LinkedIn and Twitter content"
→ Focus on 2 platforms only. Generate 3 LinkedIn posts (story, insight, question) and 5 Twitter pieces (thread, 3 tweets, hot take).

**Example 3:** "Atomize in volume mode" (after affiliate-blog-builder)
→ Pick up article from chain. Generate 25-30 pieces with multiple variations per platform for A/B testing.

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Each atomized piece is a new touchpoint driving affiliate clicks. 15-30 pieces from 1 article = 15-30x more chances for commission
- **Benchmark**: Top affiliate content creators report 2-5% of social impressions convert to link clicks. At $50 avg commission, 10,000 impressions across all pieces = $100-250/month from ONE pillar article
- **Key metric to track**: Bio link / affiliate link CTR per platform — which platform drives the most clicks per impression?

### Do This Right Now (15 min)

1. Pick the **single strongest piece** from the output — the one with the most specific, surprising insight
2. Post it on your highest-engagement platform immediately
3. Add your affiliate link in bio or first comment
4. Set a reminder to post the next piece tomorrow

### Track Your Results

After 7 days, check: which platform generated the most affiliate link clicks? Double down on that platform, reduce effort on underperformers.

> **Next step — copy-paste this prompt:**
> "Schedule all my atomized content for the next 30 days" → runs `social-media-scheduler`

## Flywheel Connections

### Feeds Into

- `social-media-scheduler` (S5) — atomized pieces ready to schedule
- `email-drip-sequence` (S5) — email-format pieces for sequences
- `ab-test-generator` (S6) — volume mode variants for testing

### Fed By

- `affiliate-blog-builder` (S3) — pillar content to atomize
- `monopoly-niche-finder` (S1) — positioning angle for all pieces
- `content-repurposer` (S7) — repurposed content to atomize further

### Feedback Loop

- `performance-report` (S6) reveals which platforms and content types perform best → focus future atomization on winning platforms

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

- Generate 5-10 variations per platform instead of 2-3
- Prioritize speed + variety over perfection
- Tag each with variant ID for A/B tracking
- Let data pick the winner (GaryVee philosophy)

```yaml
volume_output:
  variants:
    - id: string # e.g., "tw-v1", "tw-v2"
      content: string # The variation
      angle: string # What makes this one different
```

## References

- `shared/references/platform-rules.md` — Platform-specific culture, format, and CTA rules
- `shared/references/ftc-compliance.md` — FTC disclosure per platform type
- `shared/references/affitor-branding.md` — Branding rules
- `shared/references/flywheel-connections.md` — Master connection map
