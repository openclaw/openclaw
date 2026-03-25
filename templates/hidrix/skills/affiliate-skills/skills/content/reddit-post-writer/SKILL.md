---
name: reddit-post-writer
description: >
  Write Reddit posts and comments that recommend affiliate products without getting
  banned or flagged as spam. Subreddit-native content that adds value first.
  Use this skill when the user asks about Reddit posts for affiliate marketing,
  writing Reddit comments that mention products, how to promote affiliate links on
  Reddit, or says "write a Reddit post for X", "how to mention affiliate on Reddit",
  "Reddit comment promoting product", "Reddit-friendly affiliate content", "post
  for r/[subreddit] about X", "share affiliate link on Reddit without getting banned",
  "genuine Reddit recommendation", "organic Reddit affiliate post", "Reddit thread
  idea for product".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "content-creation", "social-media", "copywriting", "reddit"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S2-Content
---

# Reddit Post Writer

Write Reddit posts and comments that earn upvotes by leading with genuine value.
The affiliate recommendation comes second — after trust is built. Reddit users
have a finely tuned spam detector. This skill helps affiliates write like Redditors,
not marketers.

## Stage

This skill belongs to Stage S2: Content

## When to Use

- User wants to drive affiliate traffic from Reddit
- User wants to recommend a product in a relevant subreddit
- User is active in a community and wants to add a helpful product mention
- User has a genuine experience with a product and wants to share it naturally
- User asks how to participate on Reddit without getting banned for self-promotion

## Input Schema

```
{
  product: {
    name: string              # (required) "Notion"
    description: string       # (optional) What the product does
    url: string               # (optional) Affiliate link — used in disclosure only
    reward_value: string      # (optional) Commission — never revealed in post
  }
  subreddit: string           # (optional) Target subreddit, e.g., "r/productivity"
  post_type: string           # (optional, default: auto) "post" | "comment_reply" | "ama_style"
  trigger_question: string    # (optional) Specific Reddit question or post you're replying to
  personal_experience: string # (optional) Real experience with the product to use as anchor
  audience: string            # (optional) Who reads this subreddit — "students", "developers"
  tone: string                # (optional, default: "genuine") "genuine" | "analytical" | "casual"
  problem_focus: string       # (optional) The specific problem this post addresses
}
```

## Workflow

### Step 1: Understand Reddit Culture First

Before writing, confirm the target subreddit context. If subreddit is provided,
use `web_search "reddit r/[subreddit] rules affiliate"` to check:

- Are affiliate links explicitly banned? (many subreddits ban them outright)
- What post formats are most common? (links, text posts, discussions)
- What gets upvoted vs. downvoted in this community?
- Is there a community expectation of neutrality or personal experience?

**Subreddits that generally tolerate product mentions:**
r/productivity, r/entrepreneur, r/Entrepreneur, r/sidehustle, r/personalfinance,
r/freelance, r/marketing, r/SEO, r/webdev, r/startups, r/smallbusiness

**Subreddits that are extremely ban-happy about promotion:**
r/frugal, r/cscareerquestions, r/AskReddit, r/personalfinance (strict on direct links)

If subreddit bans affiliate links: do NOT write a post with a link. Instead, write
a post that mentions the product by name with a note like "Search for [product]
affiliate program if interested." Disclose and redirect.

### Step 2: Determine the Post Type

**Option A — Original Post (new thread):**
Best when there's no existing discussion. Write a story, question, or breakdown that
organically leads to a product mention.

- "How I went from X to Y — the exact tools I used"
- "Anyone else use [product] for [use case]? Here's my 6-month review"
- "I tested 5 [category] tools so you don't have to — honest breakdown"

**Option B — Comment Reply (responding to an existing post):**
Highest trust format. Someone asks "what tool do you use for X?" and you reply helpfully.

- Write a substantive answer that doesn't mention the product until the 3rd+ paragraph
- Add value even without the product mention — if removed, the comment should still be helpful
- Product mention: "Personally, I use [product] and it's been solid for [specific use case]"

**Option C — AMA-Style / Experience Share:**
"I've been doing [X] for [N] years. Happy to share what's worked."

- Opens conversation, positions creator as authority
- Product naturally comes up when people ask "what tools do you use?"

If `trigger_question` is provided → use Option B. Otherwise, default to Option A.

### Step 3: Research Product and Find Reddit-Specific Angles

Use `web_search "reddit [product name] review"` to find:

- What real Reddit users are saying about the product (use their language)
- Common objections raised on Reddit (address these proactively)
- How competitors are discussed (context for framing)
- Questions people ask that your post can answer

Also use `web_search "reddit [problem space] best tools"` to understand:

- What alternatives Redditors currently recommend
- How to frame your recommendation as additive, not replacing their preferences
- What not to say (phrases that get downvoted in this community)

### Step 4: Write the Post

**Reddit post structure that converts:**

1. **Title** (for new posts): specific, searchable, sounds like a real person's question or story
   - Good: "I tried 4 project management tools over 2 years — here's what I actually use now"
   - Bad: "The BEST productivity tool I've ever used!! (link in post)"
   - Good: "[6 months update] How I finally stopped context-switching between apps"

2. **Opening paragraph**: establish credibility or relatability. NO product mention here.
   - "I've been freelancing for 3 years and I'm embarrassed by how long I tried to manage
     everything in spreadsheets."

3. **Body**: share the actual useful content — your experience, the problem, what you tried.
   This section should be valuable even without the product mention.

4. **Product introduction** (70-80% through the post): introduce naturally.
   - "Eventually I landed on [product] and I've stuck with it for [X months]."
   - Specific use case: what exactly you use it for, not vague praise
   - ONE honest con: "It's not perfect — the mobile app is weak — but for desktop work
     it's exactly what I needed." Cons dramatically increase trust.

5. **FTC disclosure** (at the bottom):
   - "Full disclosure: the link in my profile leads to an affiliate link. No extra cost
     to you, and I would recommend this tool regardless."
   - Or if not posting a link: "Not affiliated, just a genuine fan."
   - Per `shared/references/ftc-compliance.md` — disclosure is required for Reddit too.

6. **Closing**: invite discussion, not clicks.
   - "Happy to answer questions about my workflow in the comments."
   - Ask a question back: "What does your current setup look like?"

### Step 5: Anti-Spam Checklist

Before finalizing, run through this checklist:

- [ ] Post adds value even if the product mention is removed
- [ ] No exclamation marks in praise ("This tool is AMAZING!!")
- [ ] No superlatives without evidence ("best tool I've ever used" → needs qualifier)
- [ ] Affiliate link goes in comments or profile bio, NOT the main post body (most subreddits)
- [ ] FTC disclosure is present and clear
- [ ] Post doesn't read like a press release
- [ ] Includes at least one real limitation or caveat about the product
- [ ] Tone matches the subreddit (match voice to community)
- [ ] Username context matters — new accounts posting affiliate content get instant downvotes

### Step 6: Add Engagement Strategy

Reddit rewards participation, not broadcasting. Include:

1. **Reply strategy**: when commenters respond, how to keep conversation going naturally
2. **Upvote path**: what type of engagement to solicit (awards, saves, discussion)
3. **Subreddit timing**: best day/time to post in this subreddit
4. **Cross-post candidates**: which other subreddits this post could work in

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] Post adds value even if product mention is removed
- [ ] No exclamation marks in product praise
- [ ] Affiliate link in comments or bio, NOT in post body
- [ ] FTC "Full disclosure: affiliate link" present at bottom
- [ ] At least one real product limitation or caveat mentioned
- [ ] Tone matches target subreddit style

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  post: {
    type: string              # "post" | "comment_reply" | "ama_style"
    subreddit: string         # "r/productivity"
    title: string | null      # For new posts only
    body: string              # Full post/comment body
    link_placement: string    # Where to put the affiliate link
    disclosure: string        # The disclosure text used
    char_count: number
  }
  subreddit_notes: {
    allows_affiliate_links: boolean
    community_tone: string
    best_post_time: string
    cross_post_subreddits: string[]
  }
  engagement_tips: string[]
  product_name: string
  content_angle: string
}
```

## Output Format

```
## Reddit Post: [Product Name]

**Type:** [New Post / Comment Reply / AMA-style]
**Target Subreddit:** [r/subreddit]
**Subreddit allows affiliate links:** [Yes / No / Link in comments only]

---

### Post Title (for new posts)

[Post title here]

---

### Post Body

[Full post text, formatted with Reddit markdown — use **bold**, *italic*, > quotes
as appropriate. Paragraphs separated by blank lines.]

---

### Link Placement

[Where to put the affiliate link — in post, in comment, or profile bio — and why]

---

### Subreddit Notes

- **Community tone:** [What vibe this subreddit has]
- **Best time to post:** [Day and time]
- **Watch out for:** [Specific rules or sensitivities]

---

### Cross-Post Opportunities

This post could also work in:
1. [r/subreddit2] — [why]
2. [r/subreddit3] — [why]

---

### Engagement Tips

1. [How to respond to likely comments]
2. [How to handle skeptics or downvotes]
3. [When to resurface this content]

---

### Alternative Angles

- **[Alternative 1]:** [Different framing for the same product]
- **[Alternative 2]:** [...]
```

## Error Handling

- **Subreddit bans affiliate links outright:** Flag this clearly. Rewrite without a direct
  link — mention the product by name only, disclosure becomes "not affiliated, genuine rec."
  Suggest building karma in the subreddit first with unrelated helpful posts.
- **No personal experience provided:** Write from a researched perspective but clearly label
  it as such ("Based on what I've seen from other users..."). Recommend the user add their
  own experience before posting — fabricated personal experience on Reddit gets called out.
- **Product is controversial on Reddit:** Acknowledge the controversy directly in the post.
  "I know [product] gets mixed reviews here. Here's my honest take after [X months]..."
  This signals authenticity and pre-empts downvote brigading.
- **User asks to mass-post the same content:** Refuse this pattern. It's spam and will
  result in account bans. Write unique versions for each subreddit.
- **New Reddit account:** Add warning: "New accounts posting affiliate content are
  immediately suspect. Build 3-6 months of genuine participation first."
- **Product has no free tier / high price:** Don't hide this. State the price early.
  "It's not cheap — $X/mo — but here's why it's been worth it for me."

## Examples

**Example 1:**
User: "Write a Reddit post for r/productivity recommending Notion"
→ No trigger question → write original post
→ Title: "Finally stopped fighting my productivity system — 18 months with Notion"
→ Body: relatable struggle with scattered notes → what I tried → landed on Notion →
specific workflows I use → honest con (learning curve) → disclosure at bottom
→ Affiliate link in first comment, not the post body

**Example 2:**
User: "Someone on r/freelance asked 'what tools do you use to manage clients?' — write a reply"
→ Comment reply format, responding to that specific question
→ Open with the full workflow (3-4 tools) — Notion is one of several, not the only mention
→ Position Notion as the project management layer specifically
→ Mention it's in my profile link if they want the affiliate version
→ Disclosure at bottom of comment

**Example 3:**
User: "Write a Reddit post about HeyGen for r/videography"
→ Check r/videography rules — likely strict about promotion
→ Frame as experience share: "I tried AI avatar video for client work — here's my honest take"
→ Include real limitations prominently (not real filmmaker footage, uncanny valley)
→ Position as "works for explainer/promo videos, not cinema" — niche and honest
→ Disclosure present, link in comments only

## References

- `shared/references/ftc-compliance.md` — FTC disclosure requirements for Reddit
- `shared/references/platform-rules.md` — Reddit-specific format and link rules
- `shared/references/affiliate-glossary.md` — terminology
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: A single well-placed Reddit post in a relevant subreddit can drive 500-5,000 clicks over its lifetime (Reddit posts rank in Google). At 2% conversion and $50 avg commission = $500-5,000 from ONE post
- **Benchmark**: Reddit affiliate posts have lower CTR (1-2%) but higher conversion rates (3-5%) than other platforms because Reddit users do deep research before buying
- **Key metric to track**: Clicks from Reddit to your affiliate link (use UTM: `?utm_source=reddit&utm_medium=post&utm_campaign=[subreddit]`)

### Do This Right Now (15 min)

1. Post the content in the target subreddit at the recommended time
2. Set your affiliate link in your Reddit profile bio (backup for subreddits that ban links)
3. Reply to the first 3 comments genuinely — engagement in the first hour determines post visibility
4. Save the post URL — it will rank in Google within 2-4 weeks

### Track Your Results

After 30 days, check: how many clicks did the post drive? What's the upvote ratio? Posts with 80%+ upvote ratio = the angle resonated. Repeat that angle for the next product.

> **Next step — copy-paste this prompt:**
> "Write a full blog review expanding on my Reddit post about [product]" → runs `affiliate-blog-builder`

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — Reddit insights expanded into long-form content
- `social-media-scheduler` (S5) — posts ready to schedule

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `purple-cow-audit` (S1) — honest product evaluation for Reddit authenticity
- `content-pillar-atomizer` (S2) — atomized Reddit pieces from pillar content

### Feedback Loop

- Post upvotes and comment sentiment reveal which product angles resonate with skeptical audiences → refine positioning for authenticity

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

- Generate 5-10 variations for different subreddits
- Prioritize speed + variety over perfection
- Tag each with variant ID for tracking
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
  skill_slug: "reddit-post-writer"
  stage: "content"
  timestamp: string
  suggested_next:
    - "social-media-scheduler"
    - "affiliate-blog-builder"
```
