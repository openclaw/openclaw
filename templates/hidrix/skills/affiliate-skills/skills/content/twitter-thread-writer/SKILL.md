---
name: twitter-thread-writer
description: >
  Write X/Twitter threads that get bookmarked, shared, and drive affiliate clicks.
  Use this skill when the user asks about writing Twitter threads, X threads, tweet
  threads for affiliate marketing, or says "write a thread about X", "Twitter thread
  promoting X", "X thread for affiliate", "write tweets that go viral", "thread that
  sells without selling", "educational thread with affiliate CTA", "Twitter content
  for affiliate marketing", "how to promote X on Twitter", "write a thread my
  audience will bookmark", "tweet storm about affiliate product".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "content-creation", "social-media", "copywriting", "twitter", "threads"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S2-Content
---

# Twitter Thread Writer

Write X/Twitter threads that deliver genuine value, build authority, and naturally
recommend affiliate products without feeling like ads. The best affiliate threads
get bookmarked for the insights and clicked for the product recommendation.

## Stage

This skill belongs to Stage S2: Content

## When to Use

- User wants to promote an affiliate product on X/Twitter
- User wants to build an audience on X while monetizing with affiliate links
- User has expertise to share and wants to weave in a product recommendation
- User asks how to write threads that convert without being spammy
- User wants content that compounds (bookmarks → future impressions)

## Input Schema

```
{
  product: {
    name: string              # (required) "ConvertKit"
    description: string       # (optional) What it does
    url: string               # (optional) Affiliate link
    reward_value: string      # (optional) For context only — never shown in thread
  }
  thread_angle: string        # (optional, default: auto) See Thread Frameworks below
  expertise_area: string      # (optional) Creator's area of authority — "email marketing", "SaaS growth"
  audience: string            # (optional) "founders", "freelancers", "content creators"
  tone: string                # (optional, default: "direct") "direct" | "educational" | "storytelling" | "contrarian"
  tweet_count: number         # (optional, default: 8) Number of tweets in thread: 5-15
  personal_story: string      # (optional) Real experience or result to anchor the thread
  cta_style: string           # (optional, default: "soft") "soft" | "direct" | "question"
}
```

## Workflow

### Step 1: Research the Product and Angle

Use `web_search "[product name] best features use cases"` and
`web_search "[product name] vs [competitor]"` to find:

- The 2-3 strongest use cases (thread body material)
- The problem it solves that X audiences care about
- Any recent updates, launches, or news (recency boosts engagement)
- Real user testimonials or case study numbers (third-party proof)

Also search `web_search "site:twitter.com [product name] affiliate"` to see what
existing threads look like — then do something different or better.

### Step 2: Select the Thread Framework

| Framework              | Structure                                                                                          | Best For                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Lessons Learned**    | "I used [product] for X months. Here's what I learned:" → 7 insights → CTA                         | Tools you've genuinely used    |
| **Problem → Solution** | Hook pain → Agitate it → Introduce solution → Show how it solves each pain → CTA                   | High-awareness problems        |
| **Contrarian Take**    | "Everyone says [common advice]. I disagree. [product] changed my mind."                            | Standing out in crowded niches |
| **Numbers Story**      | "From [before metric] to [after metric] using [product]. Here's how:" → step-by-step → CTA         | When you have real results     |
| **How-to Tutorial**    | "How to [achieve outcome] with [product] in [timeframe]:" → step-by-step → CTA                     | Educational, drives bookmarks  |
| **Tool Stack**         | "My [role] tool stack in 2024: Thread on each → [product] gets its own deep-dive tweet → CTA       | Multi-product threads          |
| **Myth Busting**       | "5 myths about [problem space] — and what actually works:" → each myth → [product] as the solution | High engagement, saves         |

Auto-select based on:

- Has personal experience → Numbers Story or Lessons Learned
- No personal experience → How-to Tutorial or Problem → Solution
- Large audience, strong takes → Contrarian Take
- Beginner-friendly product → How-to Tutorial

### Step 3: Write the Hook Tweet (Tweet 1)

The hook tweet determines if anyone reads tweet 2. It must:

- Promise a specific, tangible outcome ("how I 3x'd my email open rate")
- Or state a bold, curiosity-generating claim ("most email marketing advice is wrong")
- Or open a story loop ("6 months ago I had 400 email subscribers. Today I have 12,000.")
- End with a signal that a thread follows: "A thread:" or "Here's how:" or "Thread 🧵"

Never start with: "I want to share...", "In this thread...", "Have you ever..."
Never use buzzwords as hooks: "game-changing", "revolutionary", "must-read"

**Hook formula:** [Specific outcome or bold claim] + [Credibility signal] + [Thread signal]

### Step 4: Write the Body Tweets (Tweets 2-N)

Each tweet in the body must:

1. **Deliver a complete thought** — readable as a standalone tweet
2. **Build on the previous tweet** — threads should reward people who read all the way
3. **Include a specific detail** — numbers, names, steps, not vague generalizations
4. **Stay under 280 characters** — hard limit. No tweet should require expanding
5. **Use whitespace** — line breaks between ideas, not wall-of-text tweets

Place the product recommendation at 60-70% through the thread (tweet 5-7 of 8-10).
It should feel discovered, not pitched:

- "The tool that actually made this easy for me: [product name]"
- "I tried 4 tools before finding [product]. Here's why it worked:"
- "If I had to pick one tool for this: [product]"

Mention the product once prominently. A brief second mention in the CTA tweet is fine.

### Step 5: Write the CTA Tweet (Last Tweet)

The CTA tweet should:

1. Summarize what the thread delivered
2. Recommend action (try the product, sign up, or check it out)
3. Include the affiliate link OR direct to bio for the link
4. Include FTC disclosure "#ad" per `shared/references/ftc-compliance.md`

Soft CTA example: "If you want to try [product], there's a free trial at [link]. I use it daily. #ad"
Direct CTA: "[Product] is how I [result]. Link to try it free: [link] #ad"

### Step 6: Add Engagement Mechanics

Increase bookmark and retweet probability:

1. **Add a summary tweet** after the CTA: "TL;DR: [3 bullets from the thread]"
   Summaries drive bookmarks from skimmers.
2. **First reply** (pinned under thread): "If you found this useful, follow me for more [topic]."
3. **Engagement question** somewhere in thread: "Which of these do you do already?
   Drop your answer below." (Boosts reply count → algorithm boost)

### Step 7: Format Output

Present tweets numbered and ready to paste. Include character count for each.
Flag any tweet at 250+ characters for potential trimming.

### Step 8: Self-Validation

Before presenting output, verify:

- [ ] Every tweet is under 280 characters
- [ ] Product mention appears at 60-70% through the thread
- [ ] FTC "#ad" is in the CTA tweet containing the link
- [ ] Hook tweet promises specific outcome or states bold claim
- [ ] No banned hook starts: "In this thread...", "I want to share..."

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  thread: [
    {
      tweet_number: number      # 1, 2, 3...
      content: string           # Full tweet text
      char_count: number        # Character count
      role: string              # "hook" | "body" | "product_mention" | "cta" | "summary"
    }
  ]
  framework: string             # Which framework was used
  product_mention_tweet: number # Which tweet number introduces the product
  disclosure_tweet: number      # Which tweet has #ad
  suggested_hashtags: string[]  # 2-3 hashtags for the thread
  best_time_to_post: string     # Optimal posting time for X
  product_name: string
  content_angle: string
}
```

## Output Format

```
## Twitter Thread: [Product Name]

**Framework:** [Name]
**Angle:** [Content angle]
**Tweets:** [N] tweets

---

**Tweet 1 (Hook)** — [X chars]
[Tweet content]

---

**Tweet 2** — [X chars]
[Tweet content]

---

*...continue for all tweets...*

---

**Tweet [N] (CTA)** — [X chars]
[Tweet content including #ad disclosure]

---

**Pinned Reply** — [X chars]
[Suggested first reply to boost engagement]

---

### Posting Guide

| Detail | Value |
|--------|-------|
| Best time to post | [Day + time] |
| First action after posting | [Like all tweets to boost visibility, pin reply] |
| Expected engagement pattern | [What metrics to watch] |

### Alternate Hook Options

- **[Hook style 2]:** "[Alternative tweet 1]"
- **[Hook style 3]:** "[Alternative tweet 1]"
```

## Error Handling

- **No product info:** Pull `recommended_program` from S1 context if available.
  Otherwise ask what product they want to promote.
- **No personal experience:** Write research-based content. Flag that personal
  experience threads get 2-3x more engagement and suggest adding a real data point.
- **Thread feels too promotional too early:** Move product mention to tweet 6+.
  Add 1-2 more value tweets before the recommendation.
- **Content is too generic:** Use `web_search` to add specific stats, quotes, or
  examples. Replace every vague claim with a concrete number or example.
- **Tweet over 280 characters:** Auto-split or suggest cut. Never truncate — the
  full thought must fit in one tweet.
- **Creator has no X following:** Add note: "New accounts should engage in replies
  for 1-2 weeks before posting threads. Algorithm rewards accounts with engagement history."

## Examples

**Example 1:**
User: "Write a Twitter thread promoting ConvertKit to freelancers"
→ Angle: "How I built a 3,000-subscriber email list as a freelancer — what worked"
→ Framework: Numbers Story
→ 9 tweets: Hook (metrics) → 6 lessons → ConvertKit mention at tweet 6 → CTA + #ad
→ Emphasis: free plan, creator-friendly, no bloat

**Example 2:**
User: "I want to write a contrarian thread about email marketing tools"
→ Angle: "Most people pick the wrong email platform. Here's why:"
→ Framework: Contrarian Take
→ Myths to bust: "Mailchimp is fine for beginners", "you need fancy automations"
→ Natural product mention: "After trying 5 tools, I settled on ConvertKit because..."

**Example 3:**
User: "8-tweet thread about HeyGen for video creators"
→ Framework: How-to Tutorial — "How to create a talking-head video without a camera"
→ Step-by-step: sign up → upload script → pick avatar → generate → edit → export
→ Product mention woven in at step 1 (that's HeyGen)
→ CTA: "HeyGen has a free plan — I made my first 3 videos for free: [link] #ad"

## References

- `shared/references/ftc-compliance.md` — #ad placement rules for Twitter/X
- `shared/references/platform-rules.md` — X character limits, link handling, thread best practices
- `shared/references/affiliate-glossary.md` — terminology
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: A viral thread (1,000+ bookmarks) can drive 200-500 affiliate link clicks from the CTA tweet. At 3% conversion and $50 commission = $300-750 per thread. Threads compound — bookmarked threads resurface in search for months
- **Benchmark**: Affiliate threads with 5,000+ impressions and 2%+ engagement rate typically convert at $0.10-0.50 per impression in affiliate revenue
- **Key metric to track**: CTA tweet click-through rate. Industry benchmark: 1-3% CTR on the last tweet. Below 1% = weak CTA or product-thread mismatch

### Do This Right Now (15 min)

1. **Post the thread NOW** at the recommended time (or schedule for the next optimal window)
2. Immediately like all your tweets in the thread (boosts visibility)
3. Post the pinned reply within 2 minutes of the thread going live
4. Reply to every comment in the first hour — this is when the algorithm decides if your thread spreads

### Track Your Results

After 48 hours: how many clicks on the affiliate link? How many bookmarks? Bookmarks predict long-term traffic — bookmarked threads get resurfaced by the algorithm for weeks.

> **Next step — copy-paste this prompt:**
> "Expand my Twitter thread about [product] into a full blog review" → runs `affiliate-blog-builder`

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — thread content expanded into blog posts
- `content-pillar-atomizer` (S2) — successful threads become content to atomize
- `social-media-scheduler` (S5) — threads ready to schedule
- `ab-test-generator` (S6) — hook variants for testing

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `purple-cow-audit` (S1) — remarkable angles for thread hooks
- `content-pillar-atomizer` (S2) — atomized Twitter pieces from pillar content

### Feedback Loop

- `performance-report` (S6) reveals which thread hooks and lengths perform best → optimize thread structure

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

- Generate 5-10 hook variations instead of 1
- Prioritize speed + variety over perfection
- Tag each with variant ID for A/B tracking
- Let data pick the winner

```yaml
volume_output:
  variants:
    - id: string
      content: string
      angle: string
```

```yaml
chain_metadata:
  skill_slug: "twitter-thread-writer"
  stage: "content"
  timestamp: string
  suggested_next:
    - "social-media-scheduler"
    - "content-pillar-atomizer"
    - "ab-test-generator"
```
