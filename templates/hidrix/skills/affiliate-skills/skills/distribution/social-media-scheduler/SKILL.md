---
name: social-media-scheduler
description: >
  Create a 30-day social media content calendar for affiliate marketing. Triggers on:
  "create a social media calendar", "30-day content plan", "social media schedule",
  "content calendar for [product]", "plan my social posts", "social media strategy",
  "schedule my affiliate posts", "content plan for LinkedIn", "30 days of content",
  "social posting schedule", "what should I post this month", "write my social content",
  "create posts for LinkedIn X Facebook", "affiliate content calendar",
  "social media plan for my affiliate program".
license: MIT
version: "1.0.0"
tags:
  [
    "affiliate-marketing",
    "distribution",
    "deployment",
    "email-marketing",
    "scheduling",
    "content-calendar",
  ]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S5-Distribution
---

# Social Media Scheduler

Generate a complete 30-day social media content calendar with post copy, hashtags, and scheduling times for LinkedIn, X (Twitter), Facebook, and Reddit. Follows the 80/20 rule: 80% value and engagement content, 20% affiliate promotions. Every post is ready to copy-paste or load into a scheduling tool.

## Stage

S5: Distribution — Social media is the top free traffic channel for affiliate marketers. This skill eliminates "what do I post today?" paralysis by giving you 30 days of content in one shot, optimized for each platform's algorithm and audience behavior.

## When to Use

- User wants a content plan for promoting an affiliate product over 30 days
- User asks for a social media calendar, posting schedule, or content strategy
- User wants platform-specific posts (LinkedIn professional angle, X casual, Reddit community-first)
- User has an audience on one or more social platforms and wants consistent posting
- Chaining from S1 (product research) — user found a product and now wants a social plan

## Input Schema

```yaml
product:
  name: string # REQUIRED — product being promoted (e.g., "Semrush")
  affiliate_url: string # REQUIRED — affiliate tracking link
  category: string # OPTIONAL — e.g., "SEO tool", "AI writing tool"
  key_benefits: string[] # OPTIONAL — top benefits. Inferred if not provided.
  price: string # OPTIONAL — e.g., "starts at $119/mo"
  free_trial: boolean # OPTIONAL — does the product have a free trial?

creator:
  niche: string # REQUIRED — your content niche (e.g., "SEO for freelancers")
  audience: string # REQUIRED — who follows you (e.g., "freelance SEO consultants")
  tone:
    string # OPTIONAL — "professional" | "casual" | "educational" | "bold"
    # Default: "educational"
  personal_story: string # OPTIONAL — brief personal experience with the product

platforms:
  - string # REQUIRED — list of platforms: "linkedin" | "x" | "facebook" | "reddit"
    # Default: ["linkedin", "x"]

calendar:
  start_date: string # OPTIONAL — ISO date (e.g., "2026-04-01"). Default: next Monday.
  posts_per_week: number # OPTIONAL — 3-7. Default: 5 (weekdays only)
  promotion_ratio: number # OPTIONAL — % of posts that are affiliate promo. Default: 20
```

**Chaining context**: If S1 (product research) was run, auto-fill `product.name`, `product.affiliate_url`, `product.key_benefits`. If S3 (blog post) was run, include 2 posts linking to the blog post. If S4 (landing page) was run, include posts driving to the landing page.

## Workflow

### Step 1: Gather Inputs

Collect required fields. If product details are available from S1, use them. Otherwise ask:

- "What product are you promoting and what's your affiliate link?"
- "What's your content niche and who's your target audience?"
- "Which platforms: LinkedIn, X, Facebook, Reddit? (pick 1-4)"

### Step 2: Plan the 30-Day Arc

Divide the month into 4 weeks with a strategic arc:

| Week   | Theme                                                      | Promo Ratio |
| ------ | ---------------------------------------------------------- | ----------- |
| Week 1 | Education + awareness — establish authority, zero sell     | 0%          |
| Week 2 | Problem agitation — surface pain points the product solves | 10%         |
| Week 3 | Solution introduction — introduce product, soft sell       | 30%         |
| Week 4 | Social proof + urgency — testimonials, results, hard CTA   | 40%         |

Overall month target: 20% promotional, 80% value/engagement.

**Post type mix** (apply across all 4 weeks):

- 30% Educational (how-to tips, frameworks, industry data)
- 20% Engagement (questions, polls, hot takes, controversial opinions)
- 20% Personal / storytelling (lessons learned, behind the scenes, wins)
- 15% Curated (share tools, articles, resources — without affiliate link)
- 15% Promotional (affiliate link posts — FTC disclosed)

### Step 3: Write Posts Per Platform

Write distinct copy for each platform. Do NOT copy the same post across platforms.

**LinkedIn** (professional, 150-300 words per post):

- Hook line: bold statement or specific number in first line (LinkedIn shows 2 lines before "see more")
- Format: short paragraphs with line breaks, 3-5 bullet points for how-to posts
- Hashtags: 3-5 at end (#SEO #ContentMarketing #FreelanceTips)
- CTA: "Comment below", "Save this for later", "Link in first comment" (for affiliate posts)
- Best posting times: Tue-Thu 8-10am and 12-2pm (user's timezone)

**X / Twitter** (concise, punchy, under 280 characters for single tweets):

- Hook: strong opener, no fluff
- Thread format for educational posts: number each tweet (1/ 2/ 3/)
- Hashtags: 1-2 only (#SEO #AItools)
- CTA: "RT if this helped", "Drop your take", direct link for promo posts
- Best posting times: Mon-Fri 9am and 6pm

**Facebook** (conversational, 100-200 words):

- More personal and community tone than LinkedIn
- Ask questions to drive comments (algorithm rewards comment activity)
- Hashtags: 2-3 only
- Image prompt included (describe what image to use)
- Best posting times: Wed-Fri 1-3pm

**Reddit** (community-first, never salesy):

- Identify 2-3 relevant subreddits for the niche (e.g., r/SEO, r/juststart, r/freelance)
- Lead with genuine value — post as a community member, not a marketer
- Affiliate link goes in comments, not the post body (per most subreddit rules)
- Title: specific and searchable (Reddit posts surface in Google)
- Format: detailed paragraph, then list takeaways
- Disclosure: "(Affiliate link in comments)" in post body
- Post max: 4 Reddit posts per month to avoid spam detection

### Step 4: Format the Calendar

Output a table-based calendar followed by individual post copy blocks.

**Calendar table format:**

```
WEEK 1 — Education & Awareness
| Day | Platform | Type | Topic |
|-----|----------|------|-------|
| Mon Apr 7 | LinkedIn | Educational | 5 SEO mistakes killing your traffic |
| Tue Apr 8 | X | Engagement | Hot take: [opinion] |
...
```

Then write each post in full:

```
---
POST [N] — [Day, Date] — [Platform] — [Type]
---
[Full post copy, ready to paste]

Hashtags: #tag1 #tag2 #tag3
CTA: [specific action]
Best time to post: [time]
[If promo: Affiliate disclosure included]
---
```

### Step 5: Output Scheduler Setup

After all posts, provide scheduling tool recommendations and import instructions.

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] 30 posts generated across 4 weeks
- [ ] 80/20 value-to-promo ratio maintained (24 value, 6 promo)
- [ ] Platform-specific formatting applied (character limits, hashtag counts)
- [ ] FTC disclosure (#ad or affiliate marker) on all promo posts
- [ ] Posting times are realistic per platform and timezone

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
calendar:
  product_name: string
  platforms: string[]
  total_posts: number
  promo_posts: number
  value_posts: number
  date_range: string # e.g., "Apr 7 – May 6, 2026"

  weeks:
    - week_number: number
      theme: string
      posts:
        - day: string # e.g., "Monday April 7"
          platform: string
          type: string # educational | engagement | personal | curated | promotional
          topic: string # one-line topic summary
          copy: string # full post copy
          hashtags: string[]
          cta: string
          post_time: string # recommended posting time
          affiliate_link: string | null

scheduler:
  recommended_tools: string[] # e.g., ["Buffer", "Later", "Hypefury"]
  import_format: string # "CSV" or "manual"
  notes: string
```

## Output Format

Deliver in three parts:

**Part 1: Calendar Overview** — platform breakdown, total post count, week-by-week themes.

**Part 2: Full Calendar** — week-by-week table (quick reference) followed by each post written in full with all components.

**Part 3: Scheduling Instructions** — recommended tools and setup notes.

Keep the full post copy blocks clearly separated so the user can copy-paste each one directly into their scheduling tool or post manually.

## Error Handling

- **No affiliate URL**: Write the calendar with `[YOUR_AFFILIATE_LINK]` placeholder. Remind user to replace before posting.
- **Too many platforms (all 4) with no experience**: "I'll build the calendar for all 4 platforms. Tip: start with just 1-2 to avoid burnout. LinkedIn + X is the best combo for most niches."
- **Vague niche ("make money online")**: Use it as-is but note: "Content performs better when you niche down. Consider 'make money online for developers' or 'passive income for designers' — let me know if you want to adjust."
- **Reddit included for a highly commercial product**: Add a note: "Reddit is community-first. I've written the posts to lead with value. Review subreddit rules before posting affiliate links — some subreddits ban them entirely."
- **Posts per week > 7**: Cap at 7 and note: "Posting more than once per day rarely improves reach and increases burnout. I've set it to 7 posts/week (once per day)."
- **No product — just wants a general content calendar**: Write a general value + engagement calendar for the niche with placeholder CTAs. Mark all affiliate post slots as [INSERT PRODUCT] for user to fill in.

## Examples

**Example 1: Single platform, known product**
User: "Create a 30-day LinkedIn content calendar for promoting Semrush to freelance SEO consultants. My link: semrush.com/ref/abc"
Action: 20 LinkedIn posts (weekdays), Week 1 SEO education, Week 2 pain points (losing clients to competitors with better data), Week 3-4 introduce Semrush with case study angles. 4 promotional posts with affiliate link.

**Example 2: Multi-platform, chained from S1**
Context: S1 found HeyGen (AI video). User is a content creator targeting YouTubers.
User: "Now make me a social calendar for LinkedIn and X."
Action: Pull product details from S1. 40 posts (20 LinkedIn + 20 X), mix of video creation tips, hot takes on AI in content, and HeyGen promotions with creator-specific angles.

**Example 3: Reddit-only for SaaS niche**
User: "I want to promote Notion affiliate on Reddit to productivity communities."
Action: 4 Reddit posts targeting r/Notion, r/productivity, r/getdisciplined. Full post body leading with genuine productivity tips, affiliate disclosure + link in comments note.

## References

- `shared/references/ftc-compliance.md` — FTC disclosure for social posts. Every affiliate link post needs "(Affiliate link)" or "#ad" per FTC rules.
- `shared/references/affitor-branding.md` — Optional Affitor mention in post footer.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Consistent posting (5x/week for 90 days) grows audience 2-5x. More audience = more affiliate link exposure. Affiliates who post consistently report $500-3,000/month by month 3, vs $50-200/month for sporadic posters
- **Benchmark**: The 80/20 calendar (6 promo posts out of 30) drives more revenue than 100% promo posting — trust-based selling converts 3x better than hard selling
- **Key metric to track**: Weekly affiliate link clicks from social posts. Goal: 10% week-over-week growth for the first 90 days

### Do This Right Now (15 min)

1. **Load Week 1 posts into your scheduling tool** — Buffer (free for 3 channels), Later, or just set phone reminders
2. **Post Day 1 content RIGHT NOW** if it's within optimal posting hours
3. **Pre-film any video content** for the week — batch filming saves 3-4 hours
4. **Set a weekly reminder** (Sunday evening) to review last week's performance and adjust next week's posts

### Track Your Results

After Week 1: which post got the most engagement? After Month 1: which platform drove the most affiliate clicks? After Month 3: what's your monthly affiliate revenue from social? If not growing 10%/week, audit your content mix with `performance-report`.

> **Next step — copy-paste this prompt:**
> "Generate a performance report for my social media affiliate content" → runs `performance-report`

## Flywheel Connections

### Feeds Into

- `performance-report` (S6) — scheduled posts to measure engagement
- `ab-test-generator` (S6) — post variants for A/B testing

### Fed By

- `viral-post-writer` (S2) — posts ready to schedule
- `twitter-thread-writer` (S2) — threads to schedule
- `content-pillar-atomizer` (S2) — atomized micro-content to schedule
- `tiktok-script-writer` (S2) — scripts to schedule for filming

### Feedback Loop

- `performance-report` (S6) reveals which posting times and platforms drive most engagement → optimize scheduling

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
  skill_slug: "social-media-scheduler"
  stage: "distribution"
  timestamp: string
  suggested_next:
    - "performance-report"
    - "ab-test-generator"
```
