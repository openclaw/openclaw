---
name: email-drip-sequence
description: >
  Write an email drip sequence for affiliate marketing. Triggers on:
  "write me an email sequence", "create a drip campaign", "email nurture sequence",
  "affiliate email funnel", "welcome email series", "email onboarding sequence",
  "write emails for my list", "set up a drip sequence", "email campaign for [product]",
  "nurture my subscribers", "email follow-up sequence", "build my email funnel",
  "write 5 emails promoting [product]", "email automation sequence".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "distribution", "deployment", "email-marketing", "email", "drip-campaign"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S5-Distribution
---

# Email Drip Sequence

Write a 5-7 email drip sequence that nurtures new subscribers from cold to warm to buyer. Follows the Welcome → Value → Value → Soft Sell → Hard Sell → Objection Handling → Follow-Up pattern. Each email includes subject line, preview text, body copy, and a single clear CTA.

## Stage

S5: Distribution — Email is the highest-ROI channel for affiliate marketers (avg $42 return per $1 spent). This skill turns a list of subscribers into a predictable revenue stream by delivering value first and selling second.

## When to Use

- User has an email list and wants to promote an affiliate product
- User just launched a lead magnet or opt-in form and needs a welcome sequence
- User wants to automate affiliate promotions via email automation (ConvertKit, Mailchimp, Beehiiv, ActiveCampaign, etc.)
- User says anything like "email sequence", "drip campaign", "email funnel", "nurture series"
- User wants a sequence for a specific product or niche
- Chaining from S1 (research) — user found a product and now wants an email sequence for it

## Input Schema

```yaml
product:
  name: string # REQUIRED — product name (e.g., "HeyGen")
  affiliate_url: string # REQUIRED — the affiliate link to promote
  category: string # OPTIONAL — product category (e.g., "AI video tool")
  reward_value: string # OPTIONAL — commission amount/percentage (e.g., "30% recurring")
  key_benefits: string[] # OPTIONAL — top 3 benefits. Auto-researched if not provided.
  price: string # OPTIONAL — product pricing (e.g., "$29/mo")

audience:
  description: string # REQUIRED — who are the subscribers? (e.g., "content creators", "SaaS founders")
  pain_point: string # OPTIONAL — main problem they want solved
  awareness_level: string # OPTIONAL — "cold" | "warm" | "hot". Default: "cold"

sequence:
  length: number # OPTIONAL — number of emails: 5, 6, or 7. Default: 7
  send_days:
    number[] # OPTIONAL — days to send (e.g., [0, 1, 3, 5, 7, 10, 14])
    # Default: [0, 1, 3, 5, 7, 10, 14]
  sender_name: string # OPTIONAL — from name (e.g., "Alex from ContentPro")
  tone:
    string # OPTIONAL — "conversational" | "professional" | "bold"
    # Default: "conversational"
  lead_magnet: string # OPTIONAL — what they opted in for (e.g., "AI tools checklist")
```

**Chaining context**: If S1 (product research) was run earlier in the conversation, pull `product.name`, `product.affiliate_url`, `product.key_benefits`, and `product.reward_value` automatically. Do not ask the user to repeat information already provided.

## Workflow

### Step 1: Gather Information

Collect required inputs. If `product.name` and `product.affiliate_url` are present (from user or S1 chain), proceed. Otherwise ask:

- "What product are you promoting and what's your affiliate link?"
- "Who are your subscribers? (e.g., freelancers, SaaS founders, content creators)"

If `product.key_benefits` is not provided, infer 3 benefits from the product name and category using your training knowledge. State: "Based on what I know about [product], I'm using these key benefits: [list]. Correct me if needed."

### Step 2: Plan the Sequence

Map each email to its purpose using the 7-email arc. For a 5-email sequence, drop emails 6 and 7. For a 6-email sequence, drop email 7.

| #   | Day | Type                    | Purpose                                                    |
| --- | --- | ----------------------- | ---------------------------------------------------------- |
| 1   | 0   | Welcome                 | Deliver lead magnet, set expectations, build trust         |
| 2   | 1   | Value                   | Teach something useful (no sell)                           |
| 3   | 3   | Value + Soft Mention    | More value, casual mention of the product                  |
| 4   | 5   | Soft Sell               | Introduce the product properly, benefits focus             |
| 5   | 7   | Hard Sell               | Clear CTA, urgency (limited offer / deadline if available) |
| 6   | 10  | Objection Handling      | Answer top 3 objections, social proof                      |
| 7   | 14  | Follow-Up / Last Chance | "Did you see this?" re-engagement email                    |

### Step 3: Write Each Email

For each email, write all four components:

**Subject Line**: 40-60 characters. Use curiosity, specificity, or direct benefit. Avoid spam trigger words (free, guaranteed, act now).

**Preview Text**: 80-100 characters. Extends the subject line, adds context or intrigue. Shown in inbox preview.

**Body Copy**:

- Email 1-2: 200-300 words. Focus on value, zero sell pressure.
- Email 3-4: 250-350 words. Introduce product naturally in context.
- Email 5: 300-400 words. Strong pitch, benefits listed, clear CTA button.
- Email 6: 250-300 words. Story-driven or testimonial-anchored.
- Email 7: 150-200 words. Short, punchy re-engagement.

**Formatting rules**:

- Short paragraphs (2-3 sentences max)
- One idea per paragraph
- Conversational opener (use "you", avoid "Dear [Name]")
- Single CTA per email (one link, one action)
- Sign off with sender name + brief sign-off line

**CTA structure**:

- Email 1: CTA = download/access lead magnet (not affiliate link)
- Email 2: CTA = read an article or reply to email (engagement)
- Email 3: CTA = soft mention "check it out" with affiliate link
- Email 4-7: CTA = affiliate link with action verb ("Try [Product] Free", "Get [X]% Off", "Start Your Trial")

### Step 4: Add Compliance Disclosures

Each email that contains an affiliate link must include a one-line FTC disclosure. Place it immediately before or after the affiliate link:

> _Affiliate disclosure: I may earn a commission if you purchase through my link, at no extra cost to you._

For email clients that strip formatting, also include plain text disclosure in the footer.

### Step 5: Output the Sequence

Present all emails in order. Each email formatted as:

```
---
EMAIL [N] — Day [X] — [Type]
---
Subject: [subject line]
Preview: [preview text]

[Body copy]

[CTA]

[Signature]
---
```

After all emails, provide the Setup Instructions section.

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] All 5-7 emails present with subject, preview text, body, and CTA
- [ ] FTC disclosure included on every email containing affiliate links
- [ ] Email spacing is logical (not all on day 1)
- [ ] Value emails outnumber pitch emails in the sequence
- [ ] CTA links point to correct affiliate URLs

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
sequence:
  product_name: string
  affiliate_url: string
  audience: string
  email_count: number
  total_days: number # span of the sequence in days
  emails:
    - number: number # 1-7
      day: number # send delay in days from signup
      type: string # welcome | value | soft-sell | hard-sell | objection | follow-up
      subject: string
      preview_text: string
      body: string # full email body
      cta_text: string # button/link text
      cta_url: string # affiliate link or engagement action

setup:
  recommended_esp: string[] # e.g., ["ConvertKit", "Beehiiv", "ActiveCampaign"]
  automation_notes: string # how to set up the delay/trigger logic
  ab_test_suggestion: string # what to A/B test first
```

## Output Format

Present the sequence as clearly separated email blocks (as shown in Step 5). After the last email, add a **Setup Instructions** section:

```
---
SETUP INSTRUCTIONS
---
ESP Recommendations: ConvertKit, Beehiiv, or ActiveCampaign
Trigger: New subscriber joins list / completes opt-in form
Delays: Set each email to fire X days after the previous
A/B Test First: Subject lines on Email 5 (the hard sell) — highest impact
Tag to apply: Add an "affiliate-[product]" tag to track clicks in your ESP
---
```

## Error Handling

- **No affiliate URL provided**: "I'll write the sequence structure now. Drop in your affiliate link where I've marked `[YOUR_AFFILIATE_LINK]` before setting it up in your ESP."
- **Unknown product**: Research the product using web search if possible. If not found, ask: "Can you tell me the top 2-3 benefits of [product]? I'll write the sequence around those."
- **Audience too vague ("everyone")**: Default to "online business owners and marketers." Note: "I used a general audience. For better conversions, replace 'you' with specific language like 'as a freelancer...' or 'for SaaS founders...' throughout."
- **No lead magnet info**: Email 1 defaults to a "welcome + what to expect" format rather than lead magnet delivery.
- **Request for 3 emails or fewer**: "A 3-email sequence is too short to build trust before the sell. I recommend at least 5. Want me to write a 5-email version?"

## Examples

**Example 1: Product + audience provided**
User: "Write an email sequence for HeyGen (my link: heygen.com/ref/abc123) targeting YouTube creators who opted in for my AI tools checklist."
Action: 7-email sequence, Day 0 delivers checklist, emails 2-3 teach AI video creation tips, emails 4-7 pitch HeyGen with creator-specific angles (save editing time, AI avatars, multilingual).

**Example 2: Chained from S1**
Context: S1 found Semrush with 30% recurring commission targeting SEO consultants.
User: "Now write an email sequence for this."
Action: Pull product details from S1 output. Write 7-email sequence targeting SEO consultants. Lead magnet assumed to be SEO-related content.

**Example 3: Minimal input**
User: "Write me a drip sequence for my Notion template affiliate program"
Action: Ask for affiliate URL and audience. Use Notion affiliate program knowledge for benefits. Write 5-email sequence (conservative default for shorter products with simpler buying journey).

## References

- `shared/references/ftc-compliance.md` — FTC affiliate disclosure requirements. Apply to every email containing an affiliate link.
- `shared/references/affitor-branding.md` — Affitor footer. Include in plain text footer of each email.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `conversion-tracker` (S6) — email links to track conversions
- `email-automation-builder` (S7) — drip sequence as automation template

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `landing-page-creator` (S4) — landing page as email link destination
- `grand-slam-offer` (S4) — offer framing for email copy
- `bonus-stack-builder` (S4) — bonus details for email content
- `value-ladder-architect` (S4) — transition sequences between ladder rungs
- `squeeze-page-builder` (S4) — opt-in page feeds email list

### Feedback Loop

- `conversion-tracker` (S6) measures email click-through and conversion rates → optimize subject lines, send timing, and CTA placement

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
  skill_slug: "email-drip-sequence"
  stage: "distribution"
  timestamp: string
  suggested_next:
    - "email-automation-builder"
    - "conversion-tracker"
```
