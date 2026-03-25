---
name: tiktok-script-writer
description: >
  Write short-form video scripts for TikTok, Instagram Reels, and YouTube Shorts
  that promote affiliate products with strong hooks, demos, and CTAs.
  Use this skill when the user asks about TikTok scripts, Reels scripts, Shorts
  scripts, short-form video for affiliate marketing, or says "write a TikTok for X",
  "script a Reel promoting X", "YouTube Shorts script affiliate", "60-second video
  script", "hook for TikTok affiliate", "write a video promoting X", "TikTok script
  that converts", "short video script for product review", "viral TikTok affiliate
  script", "how to promote X on TikTok".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "content-creation", "social-media", "copywriting", "tiktok", "video"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S2-Content
---

# TikTok Script Writer

Write punchy 30-60 second video scripts for TikTok, Instagram Reels, and YouTube
Shorts that stop the scroll, demo the product naturally, and drive affiliate link
clicks. Every script is structured for vertical video: hook → problem → demo →
result → CTA.

## Stage

This skill belongs to Stage S2: Content

## When to Use

- User wants to promote an affiliate product on short-form video platforms
- User has an affiliate program picked (from S1) and needs TikTok/Reels content
- User asks for video script ideas for TikTok affiliate marketing
- User wants a hook-first script that converts viewers to buyers
- User creates content on TikTok, Instagram Reels, or YouTube Shorts

## Input Schema

```
{
  product: {
    name: string              # (required) "HeyGen"
    description: string       # (optional) What it does — will be researched if missing
    url: string               # (optional) Affiliate link or product URL
    reward_value: string      # (optional) Commission info — never shown in script
  }
  duration: number            # (optional, default: 45) Target duration in seconds: 15 | 30 | 45 | 60
  platform: string            # (optional, default: "tiktok") "tiktok" | "reels" | "shorts" | "all"
  hook_style: string          # (optional, default: auto) "question" | "shock" | "relatable" | "bold_claim" | "demo_first"
  creator_persona: string     # (optional) "beginner marketer" | "tech reviewer" | "productivity nerd"
  has_product_access: boolean # (optional, default: true) Can creator do live demo?
  personal_experience: string # (optional) Real experience to weave in
  audience: string            # (optional) "freelancers" | "small business owners" | "students"
}
```

## Workflow

### Step 1: Research the Product

If product details are sparse, use `web_search "[product name] what it does tutorial"` to find:

- The single most impressive thing the product does (demo-able in <20 seconds)
- The main pain it eliminates (hook material)
- A specific result users achieve (e.g., "make a talking avatar video in 2 minutes")
- Any free trial or free tier (reduces friction for CTA)

Concrete specifics > vague claims. "Creates a 2-minute video in 30 seconds" beats
"saves time on video creation".

### Step 2: Select the Hook Style

Short-form video is won or lost in seconds 1-3. Pick the hook based on the product's
strongest angle:

| Hook Style       | Template                                                            | Best For                         |
| ---------------- | ------------------------------------------------------------------- | -------------------------------- |
| **Question**     | "What if you could [result] without [pain]?"                        | Products that remove a hard task |
| **Shock/Stat**   | "I replaced [expensive thing] with a $[price]/mo tool"              | Cost/efficiency wins             |
| **Relatable**    | "[Frustrating situation]? Same. Then I found this."                 | Niche audience pain              |
| **Bold Claim**   | "This [tool] is the reason I [impressive result]"                   | Strong ROI proof                 |
| **Demo First**   | [Open with screen recording of the coolest feature immediately]     | Visual/AI tools                  |
| **Story Opener** | "6 months ago I was [before state]. Now [after state]. Here's why." | Transformation                   |

For AI tools and visual products → **Demo First** almost always wins on TikTok.
For SaaS productivity tools → **Relatable** or **Shock/Stat** hooks work well.

### Step 3: Structure the Script

Every script follows this structure (adapt timing to duration):

**For 45-second scripts:**

- 0-3s: Hook (spoken + on-screen text)
- 3-8s: Relatable pain or setup
- 8-30s: Live demo OR narrated walkthrough of key feature
- 30-38s: Specific result / proof
- 38-44s: CTA (bio link, comment for link, or "link in bio")
- 44-45s: FTC disclosure overlay

**For 30-second scripts:**

- 0-3s: Hook
- 3-15s: Demo the #1 feature
- 15-25s: Result + social proof
- 25-30s: CTA + disclosure

**For 60-second scripts:**

- 0-3s: Hook
- 3-10s: Problem setup
- 10-40s: Full demo (2-3 features)
- 40-52s: Results + pricing mention (anchoring)
- 52-58s: CTA
- 58-60s: FTC disclosure

### Step 4: Write the Script

Format scripts with:

- **[VISUAL]** — what's on screen (screen recording, hands typing, reaction face, b-roll)
- **[SPOKEN]** — what the creator says (keep sentences short, max 10 words each)
- **[TEXT OVERLAY]** — on-screen text (keywords for silent viewers — 40% watch with no sound)
- **[CAPTION]** — suggested TikTok caption + hashtags

Writing rules:

1. Sentences under 10 words. TikTok viewers process fast.
2. No filler phrases: "basically", "literally", "you know what I mean"
3. Every 3-5 seconds: new visual cut, new text overlay, or spoken transition
4. Sound-optional: the text overlay should tell the whole story without audio
5. End the hook WITH the setup — don't just ask a question, tease the answer
6. The demo must be REAL — no vague "and then it does this amazing thing"

### Step 5: Add FTC Disclosure

Per `shared/references/ftc-compliance.md` for short-form video:

- Verbal disclosure if spoken at all (not required but best practice)
- Text overlay "#ad" or "Affiliate link in bio" must appear during CTA section
- Disclosure must be visible for at least 3 seconds
- Do NOT bury in caption — overlay is required per FTC guidance

### Step 6: Add Production Notes

Include brief notes for the creator:

- What to screen-record vs. film on camera
- Suggested background music BPM range (fast = tech demos, mid = tutorials)
- Caption and hashtag strategy for the platform
- Best time to post on each platform

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] Spoken sentences under 10 words each
- [ ] New visual cut or text overlay every 3-5 seconds
- [ ] FTC "#ad" appears as text overlay, NOT buried in caption
- [ ] Disclosure overlay visible for at least 3 seconds
- [ ] Hook ends with setup, not just a question
- [ ] Demo shows specific feature, not vague claims

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  scripts: [
    {
      platform: string          # "tiktok" | "reels" | "shorts"
      duration_seconds: number  # 45
      hook_style: string        # "demo_first"
      scenes: [
        {
          timecode: string      # "0-3s"
          visual: string
          spoken: string
          text_overlay: string
        }
      ]
      caption: string           # Full TikTok caption
      hashtags: string[]        # Suggested hashtags
      disclosure: string        # How and when FTC disclosure appears
    }
  ]
  product_name: string
  content_angle: string
  hook_used: string
}
```

## Output Format

```
## TikTok Script: [Product Name] ([Duration]s)

**Hook Style:** [Style name]
**Platform:** [TikTok / Reels / Shorts]
**Target Audience:** [Who this is for]

---

### Script

| Time | Visual | Spoken | Text Overlay |
|------|--------|--------|-------------|
| 0-3s | [What's on screen] | "[Hook line]" | [On-screen text] |
| 3-8s | [Visual] | "[Spoken]" | [Overlay] |
| ... | ... | ... | ... |

---

### Caption

[Full caption text — optimized for TikTok SEO]

**Hashtags:** #[tag1] #[tag2] #[tag3] (5-8 tags max)

---

### Production Notes

- **Film:** [Camera vs screen recording breakdown]
- **Music:** [BPM and mood suggestion]
- **Best time to post:** [Platform-specific optimal time]
- **Disclosure:** #ad text overlay appears at [timecode] for [X] seconds

---

### Hook Alternatives

Want a different opening? Try:
- **[Hook Style 2]:** "[Alternative opening line]"
- **[Hook Style 3]:** "[Alternative opening line]"
```

## Error Handling

- **No product info:** Ask what product they're promoting. If they came from S1, pull
  `recommended_program` from context.
- **Product isn't visual / hard to demo:** Shift to reaction/testimonial format —
  creator's face on screen reacting to the tool, narrating the discovery.
- **User has no product access:** Write a "third-person discovery" script —
  "My friend showed me this tool and I had to share it"
- **Duration feels too long for the content:** Cut the demo to single strongest moment.
  If 30s still feels crowded, suggest two separate videos (problem setup + solution).
- **Platform unspecified:** Default to TikTok. Mention Reels and Shorts are the same script
  with minor caption/hashtag adjustments.

## Examples

**Example 1:**
User: "Write a 45-second TikTok script for HeyGen"
→ Research: HeyGen creates AI avatar videos, talking head from text
→ Hook: Demo first — open with a finished AI video playing
→ Script: [0-3s] Show output video → [3-8s] "Made this in 2 minutes, no camera" →
[8-30s] Screen record: paste script → avatar speaks → [30-38s] "Used this for
my client, saved 4 hours" → [38-44s] "Link in bio, 30-day free trial" → [44-45s] "#ad overlay"

**Example 2:**
User: "TikTok script for Notion affiliate, targeting students"
→ Hook: Relatable — "POV: it's 2am before finals and your notes are chaos"
→ Demo: Notion AI organizing scattered notes into a study guide
→ CTA: "Free forever plan — link in bio"
→ Caption: "study with me + notion hacks" for algorithm reach

**Example 3:**
User: "I need 3 different hooks for a ConvertKit TikTok script"
→ Write hook-only variants: Question / Shock / Bold Claim
→ Full script for the strongest one, alternative openings for others
→ Note which hook style historically performs best for SaaS on TikTok

## References

- `shared/references/ftc-compliance.md` — disclosure rules for short-form video
- `shared/references/affiliate-glossary.md` — reward_type and program terminology
- `shared/references/platform-rules.md` — TikTok/Reels/Shorts format specs
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: TikTok affiliate videos average 1-3% bio link click rate. A video with 10,000 views = 100-300 bio link clicks. At 2% conversion and $50 commission = $100-300 per viral video
- **Benchmark**: Top TikTok affiliates report $500-2,000/month from 3-5 videos per week. The algorithm rewards consistency — your 10th video performs better than your 1st
- **Key metric to track**: Bio link clicks per video (use a link-in-bio tool with click tracking like Beacons or your own bio-link page from `bio-link-deployer`)

### Do This Right Now (15 min)

1. **Film the script TODAY** — don't wait. The script is ready, your phone is the camera
2. Screen-record the product demo section (the hardest part to improvise)
3. Post on TikTok, then cross-post to Instagram Reels and YouTube Shorts (3 platforms, 1 video)
4. Add your affiliate link to your bio before posting

### Track Your Results

After 5 videos, check: which hook style got the highest completion rate? Which video drove the most bio link clicks? Use that hook style for your next 5 videos.

> **Next step — copy-paste this prompt:**
> "Schedule my TikTok content for the next 30 days" → runs `social-media-scheduler`

## Flywheel Connections

### Feeds Into

- `social-media-scheduler` (S5) — scripts ready to schedule for filming/posting
- `content-pillar-atomizer` (S2) — successful scripts become content to atomize further

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `purple-cow-audit` (S1) — remarkable angles for script hooks
- `content-pillar-atomizer` (S2) — atomized TikTok scripts from pillar content

### Feedback Loop

- Video view count and completion rate reveal which hook styles work → optimize hook selection

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

- Generate 5-10 hook variations for the same product
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
  skill_slug: "tiktok-script-writer"
  stage: "content"
  timestamp: string
  suggested_next:
    - "social-media-scheduler"
    - "content-pillar-atomizer"
```
