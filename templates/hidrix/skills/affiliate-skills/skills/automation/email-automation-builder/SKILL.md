---
name: email-automation-builder
description: >
  Build multi-sequence email automation flows with branching logic. Triggers on:
  "build email automation", "create email funnel", "email automation flow",
  "welcome series with branches", "conditional email sequence", "set up automation",
  "email workflow builder", "segmented email flow", "advanced email sequence",
  "nurture funnel", "cart abandonment sequence", "win-back email flow".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "automation", "scaling", "workflow", "email"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S7-Automation
---

# Email Automation Builder

Build multi-sequence email automation flows with branching logic, segmentation, triggers, and tool-specific setup. More advanced than S5 email-drip-sequence: this skill creates conditional flows that respond to subscriber behavior (opened, clicked, purchased). Output includes ASCII flow diagrams, email content, and platform setup instructions.

## Stage

S7: Automation — S5's email-drip-sequence is a linear 7-email series. Real email marketing uses branching flows: if they opened → send X, if they didn't → send Y, if they clicked the affiliate link → move to a different sequence. This skill builds the automation system, not just the emails.

## When to Use

- User needs email flows with conditional logic (if/then branches)
- User wants welcome series, nurture flows, win-back campaigns, or cart abandonment
- User says "email automation", "branching email", "conditional sequence"
- User wants to set up flows in ConvertKit, Mailchimp, ActiveCampaign, or Beehiiv
- User already has an S5 drip sequence and wants to upgrade it to a full automation
- Chaining: upgrade S5 `email-drip-sequence` output to a branching automation

## Input Schema

```yaml
product:
  name: string # REQUIRED — product being promoted
  affiliate_url: string # REQUIRED — affiliate link
  reward_value: string # OPTIONAL — commission info (e.g., "30% recurring")

audience:
  description: string # REQUIRED — who the subscribers are
  segments: # OPTIONAL — audience segments for branching
    - string # e.g., ["cold_leads", "warm_leads", "buyers"]

flow_type:
  string # OPTIONAL — "welcome" | "nurture" | "winback"
  # | "reengagement" | "cart_abandon"
  # Default: "welcome"

email_tool:
  string # OPTIONAL — "convertkit" | "mailchimp"
  # | "activecampaign" | "beehiiv"
  # Default: generic (works with any ESP)

num_emails:
  number # OPTIONAL — total emails in the flow (5-12)
  # Default: 7

lead_magnet: string # OPTIONAL — what they opted in for
```

**Chaining context**: If S5 email-drip-sequence was run earlier, offer to upgrade it: "I see you have a 7-email drip sequence. Want me to upgrade it with branching logic and segments?"

## Workflow

### Step 1: Map Flow Type to Template

Select automation template based on `flow_type`:

**Welcome Flow**: Trigger → Welcome email → Wait 1 day → Value email → Branch (opened? → Soft sell / didn't open? → Re-engagement) → Continue selling to openers, re-engage non-openers

**Nurture Flow**: Trigger → Educational series → Branch (clicked affiliate link? → Move to sales sequence / didn't click? → Continue nurturing) → Post-purchase thank you for converters

**Win-back Flow**: Trigger (inactive 30+ days) → "We miss you" → Wait 3 days → Value reminder → Branch (re-engaged? → Move to nurture / still inactive? → Last chance) → Sunset after no response

### Step 2: Define Triggers and Entry Conditions

For each flow, specify:

- **Entry trigger**: What starts the flow (new subscriber, tag added, purchase, inactivity)
- **Exit conditions**: What removes someone (purchase, unsubscribe, entered different flow)
- **Branch conditions**: Opens, clicks, purchases, time-based

### Step 3: Design Branching Logic

Create decision points:

- After email N: Did they open? (Branch A: opened, Branch B: not opened)
- After email N: Did they click affiliate link? (Branch A: clicked, Branch B: didn't)
- After email N: Did they purchase? (Branch A: buyer → thank you, Branch B: non-buyer → continue)

### Step 4: Write Each Email

For each email in each branch, write:

- Subject line (40-60 chars)
- Preview text (80-100 chars)
- Body copy (200-400 words)
- CTA (single, clear)
- FTC disclosure (for emails with affiliate links)

### Step 5: Add Wait Times

Between emails:

- Welcome flow: 0, 1, 2, 3, 5, 7, 10 days
- Nurture flow: 2, 4, 7, 10, 14 days
- Win-back flow: 0, 3, 7, 14 days
- Adjust based on audience engagement patterns

### Step 6: Output Flow + Setup

Present:

- ASCII flow diagram showing the full automation
- Each email's content
- Tool-specific setup instructions (if email_tool specified)

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] Every branch path leads to a valid next step (no dead ends)
- [ ] All emails are complete in each branch (subject, body, CTA)
- [ ] Wait times between emails sum correctly to total flow duration
- [ ] FTC disclosure present on all emails containing affiliate links
- [ ] Branch conditions are clear boolean logic (opened/clicked/didn't)

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
automation:
  flow_type: string
  product: string
  total_emails: number
  total_branches: number
  estimated_days: number # total span of the flow

flow:
  - step: number
    type: string # "email" | "wait" | "branch" | "exit"
    email: # present if type is "email"
      subject: string
      preview: string
      body: string
      cta: string
      has_affiliate_link: boolean
    wait_days: number # present if type is "wait"
    branch: # present if type is "branch"
      condition: string # e.g., "opened previous email?"
      yes_path: number # step number for yes
      no_path: number # step number for no

setup:
  tool: string
  steps: string[] # tool-specific setup instructions
  tags: string[] # recommended tags to apply
  segments: string[] # recommended segments
```

## Output Format

1. **Flow Overview** — flow type, total emails, total days, branch count
2. **ASCII Flow Diagram** — visual representation of the automation with branches
3. **Email Content** — each email with subject, preview, body, CTA (grouped by branch)
4. **Setup Instructions** — tool-specific steps to build this automation
5. **Tags & Segments** — recommended tagging strategy for tracking

## Error Handling

- **No product info**: "What affiliate product are you promoting? I need the product name and your affiliate link to write the email content."
- **Unknown email tool**: "I don't have specific setup instructions for [tool]. I'll provide generic automation logic that works with any ESP — just map the triggers, waits, and branches to your tool's interface."
- **Too many emails requested (>12)**: "12+ emails in one flow is usually too many. I'll create a 7-email flow with branches. For longer nurture, consider chaining two separate flows."
- **Upgrading from S5**: "I see your existing 7-email drip. I'll keep the email content and add branching logic: opened/not-opened splits after emails 2 and 4, and a purchase detection branch after email 5."

## Examples

### Example 1: Welcome flow with branches

**User**: "Build a welcome email automation for HeyGen (affiliate link: heygen.com/ref/abc123) for content creators who downloaded my AI tools guide."
**Action**: 7-email welcome flow. Email 1: Deliver guide. Email 2: Value (AI video tip). Branch: Did they open email 2? Yes → Email 3 (soft sell HeyGen). No → Email 3b (re-engagement with different subject). Continue branching through to email 7. ASCII diagram + all email content + ConvertKit setup.

### Example 2: Upgrade existing S5 drip

**User**: "Take my email drip sequence from earlier and add automation logic."
**Action**: Keep the 7 emails from S5 output. Add branches: After email 2 (opened → continue / not opened → resend with new subject). After email 4 (clicked affiliate link → skip to email 5 hard sell / didn't click → add extra value email). After email 5 (purchased → exit + thank you / didn't purchase → continue to email 6-7).

### Example 3: Win-back flow

**User**: "Create a win-back sequence for subscribers who haven't opened emails in 30 days. I promote Semrush."
**Action**: 4-email win-back flow. Trigger: 30 days no opens. Email 1: "Still interested in SEO?" (curiosity). Wait 3 days. Email 2: Value piece (SEO tip). Branch: Opened? Yes → Move to nurture flow. No → Email 3: "Last chance" (urgency). No response after 7 days → Sunset (remove from list).

## References

- `shared/references/ftc-compliance.md` — FTC disclosure for emails with affiliate links. Read in Step 4.
- `shared/references/affitor-branding.md` — Branding guidelines for email footers. Referenced in Step 4.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Email automation is the closest thing to passive income in affiliate marketing. A well-built welcome flow converts 5-15% of subscribers to affiliate clicks. With 500 new subscribers/month × 10% click rate × 3% conversion × $50 commission = $750/month on autopilot
- **Benchmark**: Email marketing delivers $42 return per $1 spent. Branching flows outperform linear sequences by 25-40% because they send the right message to the right person at the right time
- **Key metric to track**: Revenue per subscriber per month. Industry benchmark for affiliate email: $0.50-2.00/subscriber/month. Below $0.50 = weak offer or poor segmentation

### Do This Right Now (15 min)

1. **Set up Email 1 (Welcome/Deliver) in your ESP today** — this is the highest-open-rate email (60-80% open rate). Get it live immediately
2. **Create the first branch trigger** — "opened Email 2?" — in your ESP's automation builder
3. **Schedule remaining emails** in the flow — most ESPs let you build the full automation in one session
4. **Test the flow** — subscribe with a test email address and verify every branch works

### Track Your Results

After 30 days: what's the open rate on each email? Click rate on affiliate links? Revenue attributed to the flow? If Email 3+ have <15% open rate, test new subject lines. If affiliate CTR is <2%, strengthen the CTA or add bonuses.

> **Next step — copy-paste this prompt:**
> "Set up conversion tracking for my email automation affiliate links" → runs `conversion-tracker`

## Flywheel Connections

### Feeds Into

- `conversion-tracker` (S6) — automated email links to track

### Fed By

- `email-drip-sequence` (S5) — drip sequence to upgrade with automation logic
- `conversion-tracker` (S6) — conversion data for branch conditions

### Feedback Loop

- `conversion-tracker` (S6) provides email conversion data → optimize branch conditions and timing

```yaml
chain_metadata:
  skill_slug: "email-automation-builder"
  stage: "automation"
  timestamp: string
  suggested_next:
    - "conversion-tracker"
    - "performance-report"
```
