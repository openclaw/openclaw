---
name: webinar-registration-page
description: >
  Build a webinar or live event registration page as a self-contained HTML file with countdown
  timer, speaker bio, agenda, and registration form. Triggers on: "build a webinar registration page",
  "create a webinar sign-up page", "event registration landing page", "live training registration page",
  "workshop sign-up page", "create a webinar page", "build an event page",
  "free webinar landing page", "live demo registration page", "online event page",
  "create a registration page for my webinar", "build a training event page".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "landing-pages", "conversion", "offers", "webinar", "registration"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S4-Landing
---

# Webinar Registration Page

Build a high-converting webinar or live training registration page as a self-contained HTML file. Features a live JavaScript countdown timer, speaker credibility section, session agenda, social proof, and a registration form that captures email leads. On registration, visitors are confirmed and teased toward the affiliate offer that will be featured in the webinar itself.

## When to Use

- User is hosting a webinar, live training, workshop, or online event
- User wants to build an email list of warm leads before promoting an affiliate product
- User says "webinar page", "event registration", "live training page", "workshop signup"
- User is running a "free training" funnel — a common high-converting affiliate strategy
- The affiliate product is the natural solution to be revealed or promoted during the event

## Workflow

### Step 1: Gather Event Details

Parse the user's request for:

- **Event title**: the name of the webinar/training
- **Presenter name and bio**: who is presenting (can be the user)
- **Date and time**: when the event happens (for the countdown timer)
- **Topic**: what the training covers
- **Affiliate product**: the product that will be featured/promoted in the webinar

**If event details are missing, ask for:**

1. "What is your webinar about? Give me a title or topic."
2. "When is it? Date, time, and timezone please."
3. "What affiliate product will you feature or recommend in the webinar?"

**If user has no real event** (wants a template/evergreen page):

- Offer "evergreen" mode: countdown timer counts down to a fake "next session" time (resets every week), always showing 3-7 days away
- Note in output: "This uses an evergreen countdown — it will always show a near-future date. Replace with a real date when you have one."

**Common webinar funnel structures:**
| Structure | Description | Best for |
|---|---|---|
| Free training → pitch | 45-60 min training, last 15 min pitches affiliate product | High-ticket SaaS, courses |
| Live demo → offer | Demo the product live, include affiliate link in follow-up | Software tools |
| Expert interview → recommendation | Interview + affiliate product recommendation | Authority-building niches |
| Challenge / workshop | Multi-day challenge, affiliate product is the tool | Fitness, marketing, business |

### Step 2: Plan the Page Structure

Read `references/conversion-principles.md` for event page conversion principles.

A webinar registration page must create urgency (countdown), credibility (speaker), and anticipation (agenda) while making registration as frictionless as possible.

Page sections:

1. **Urgency Bar** (top, sticky) — "Free Live Training: [Topic] — [Date at Time timezone] — [N seats remaining]"
2. **Hero Section**:
   - Event label: "FREE LIVE WEBINAR" or "FREE TRAINING"
   - Headline: the transformation promise of the event
   - Sub-headline: what attendees will learn + who it's for
   - Date/time with timezone
   - Registration form (first name + email + submit)
   - Seat scarcity signal: "Limited to [N] attendees"
3. **Countdown Timer** (below hero fold):
   - Live JavaScript countdown: Days / Hours / Minutes / Seconds
   - Label: "The training starts in:"
4. **What You'll Learn** — 4-6 bullet points (specific outcomes, not vague topics)
5. **Speaker Section**:
   - Name + headshot placeholder (styled CSS avatar)
   - Role / credentials
   - 2-3 sentence bio establishing expertise
   - Social proof: "Helped [N] people [outcome]"
6. **Agenda Section** — 3-5 session blocks with time + title + brief description
7. **Who This Is For** — 4-5 bullet points naming the ideal attendee (and 2 "this is NOT for you if" bullets)
8. **Testimonials** — 2-3 from past attendees (or representative examples)
9. **FAQ** — 5-7 questions about the event logistics
10. **Second Registration Form** — repeat below the fold for scrollers
11. **Footer** — FTC disclosure, privacy note, Affitor attribution

**Affiliate integration in the webinar funnel:**
The registration page itself should NOT aggressively sell the affiliate product — that's the webinar's job. But it should:

- Tease the product in the "What You'll Learn" section: "Discover the exact tool I use to [outcome] (I'll share the link during the training)"
- Include a subtle line in the description: "We'll cover [topic] using [Product] — the tool that [benefit]"

### Step 3: Build the Countdown Timer

The countdown timer is the most technically important element. Implement it correctly:

```javascript
function getEventDate() {
  // Replace with actual event timestamp
  return new Date("[ISO_DATE_STRING]");
}

function updateCountdown() {
  const now = new Date();
  const event = getEventDate();
  const diff = event - now;

  if (diff <= 0) {
    document.getElementById("countdown").innerHTML =
      '<div class="countdown-ended">The training has started! <a href="[join_url]">Join now →</a></div>';
    return;
  }

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  // Update DOM elements
  document.getElementById("cd-days").textContent = String(days).padStart(2, "0");
  document.getElementById("cd-hours").textContent = String(hours).padStart(2, "0");
  document.getElementById("cd-minutes").textContent = String(minutes).padStart(2, "0");
  document.getElementById("cd-seconds").textContent = String(seconds).padStart(2, "0");
}

setInterval(updateCountdown, 1000);
updateCountdown();
```

**Evergreen mode** (if no real date provided):

```javascript
function getEventDate() {
  const now = new Date();
  const daysUntilNext = 5; // Always 5 days away
  return new Date(now.getTime() + daysUntilNext * 24 * 60 * 60 * 1000);
}
```

### Step 4: Write the Full HTML

**Copy requirements:**

_Event headline formula:_

- "How to [Achieve Specific Outcome] in [Timeframe] — Even If [Common Objection]"
- "The [Adjective] [Method/System] That Helped [N] [People] [Achieve Outcome]"
- "Free Live Training: [Topic] — [Specific Claim About the Session]"

_Urgency bar copy:_

- "FREE LIVE TRAINING — [Short Title] — [Weekday, Month Day] at [Time] [TZ] — [N] Spots Left"

_What You'll Learn bullets (outcome-first format):_

- "[Specific skill/tactic] — so you can [specific result]"
- "The [method/framework] that [social proof claim]"
- "Why [common mistake] is killing your results — and how to fix it in [timeframe]"

_Speaker bio (credibility elements to include):_

- Years of experience or number of clients/students
- Specific, verifiable result they achieved
- Notable publication, company, or platform they've appeared on
- Why they're qualified to teach this specific topic

_Agenda block format:_

```
[Time Marker] — [Session Title]
[One sentence description of what happens in this block]
```

**HTML/CSS requirements:**

- All CSS inline in `<style>` block
- Mobile-first responsive
- Countdown timer: large digits in boxes with labels (Days/Hours/Min/Sec)
- Color scheme applied to: urgency bar, countdown boxes, CTA buttons, section accents
- Registration form: first name + email fields + submit button
- Form submission: JS redirect to a confirmation page or affiliate thank-you URL
- Speaker avatar: styled CSS circle placeholder (bg color + initials)
- Agenda: timeline-style visual with numbered steps or time markers

**Required elements:**

- FTC disclosure in footer: "This training may reference affiliate products. We may earn a commission on purchases."
- Privacy note near form: "No spam. Unsubscribe anytime. Your information is never shared."
- "Built with Affiliate Skills by Affitor" footer from `shared/references/affitor-branding.md`

### Step 5: Format Output

**Part 1: Page Summary**

```
---
WEBINAR REGISTRATION PAGE
---
Event: [title]
Presenter: [name]
Date/Time: [event date] OR [evergreen mode]
Topic: [what the webinar covers]
Affiliate Product: [product featured in the webinar]
Registration Form: [fields collected]
Post-Registration: [where visitor goes after submitting]
Countdown: [live / evergreen]
Color: [scheme applied]
---
```

**Part 2: Complete HTML**
Full file in a fenced code block. Save as `[webinar-slug]-registration.html`.

**Part 3: Setup Instructions**

```
---
SETUP
---
1. Save as `[event-slug]-registration.html`
2. Update the event date: find `[ISO_DATE_STRING]` in the JS and replace with your event's ISO 8601 timestamp
   e.g., "2025-04-15T19:00:00-05:00" for April 15, 2025 at 7pm Central
3. Wire the registration form to your webinar platform:
   - Zoom Webinars: Use Zoom's registration API or replace form action with Zoom's embed
   - Demio: Replace form with Demio's embed code
   - StreamYard / YouTube Live: Collect emails with a simple form, send Zoom link via email
   - Generic (Mailchimp/ConvertKit): Point form to your ESP, send the webinar link in welcome email
4. Replace post-registration redirect: find `[CONFIRMATION_URL]` and replace with your thank-you page or affiliate link
5. Deploy: Netlify Drop / Vercel / GitHub Pages
---
```

## Input Schema

```yaml
event:                      # REQUIRED
  title: string             # Webinar title
  topic: string             # What the training covers
  date: string              # ISO 8601 or "evergreen" for no fixed date
  time: string              # "7:00 PM Eastern" — human readable
  duration_minutes: number  # Optional — defaults to 60

presenter:                  # REQUIRED
  name: string
  title: string             # Job title or credential
  bio: string               # 2-3 sentences
  social_proof: string      # "Helped 500+ businesses", "10K+ students", etc.

affiliate_product:          # REQUIRED — product featured in the webinar
  name: string
  url: string               # Affiliate link (used in post-registration or post-webinar email)
  description: string
  reward_value: string

what_you_will_learn: string[]  # OPTIONAL — 4-6 bullet points
                               # Default: auto-generated from topic

agenda: object[]            # OPTIONAL — session blocks
  - time_marker: string     # e.g., "0:00", "Minute 0", "Part 1"
    title: string
    description: string

testimonials: object[]      # OPTIONAL — past attendee quotes
  - quote: string
    name: string            # Can be first name only
    result: string

seats_available: number     # OPTIONAL — scarcity signal. Default: 100

color_scheme: string        # OPTIONAL — "blue" | "green" | "purple" | "orange" | "dark" | hex
                            # Default: "purple" (webinar industry standard)

webinar_platform: string    # OPTIONAL — "zoom" | "demio" | "youtube-live" | "streamyard" | "other"
                            # Used to customize setup instructions
```

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] FTC disclosure in footer mentioning affiliate products
- [ ] Countdown timer JavaScript calculates correctly
- [ ] Form has first name + email fields + submit button
- [ ] Self-contained HTML: speaker avatar is CSS placeholder, no external images
- [ ] "Built with Affiliate Skills by Affitor" footer present
- [ ] Urgency bar present at top with date/time and scarcity signal

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
registration_page:
  event_title: string
  presenter_name: string
  event_date: string # "2025-04-15T19:00:00-05:00" or "evergreen"
  countdown_mode: string # "live" | "evergreen"
  color_scheme: string
  html: string
  filename: string # e.g., "ai-video-mastery-webinar.html"

funnel:
  step_1: string # "Visitor sees registration page"
  step_2: string # "Visitor registers (submits email)"
  step_3: string # "Visitor attends webinar"
  step_4: string # "Affiliate product featured during webinar"
  step_5: string # "Visitor clicks affiliate link"

affiliate_integration:
  product_name: string
  tease_on_page: string # How the product is referenced on the reg page
  reveal_in_webinar: string # Suggested moment to introduce the product

deploy:
  local: string
  platform_specific: string # Instructions for the user's webinar platform
```

## Output Format

Present as three sections:

1. **Page Summary** — event details, presenter, countdown mode, affiliate integration plan
2. **HTML** — complete file in a code block
3. **Setup Instructions** — how to set the event date, wire the form, and deploy

## Error Handling

- **No event date provided**: "Do you have a specific date, or should I use evergreen mode (timer always shows ~5 days away)?"
- **No presenter name**: Default to "Your Host" as a placeholder, note: "Replace 'Your Host' with your name and bio before publishing."
- **No agenda provided**: Auto-generate a 4-part agenda based on the topic. Inform user: "I've created a sample agenda — customize the timing and details."
- **User wants form to actually register people**: Explain static HTML limitation. Recommend Zoom Webinar registration link, Demio embed, or Mailchimp form with the webinar link in the welcome email.
- **Evergreen webinar (not live)**: If the user says "evergreen webinar" or "automated webinar", shift framing away from "live" language. Replace "Join us live" with "Watch the free training". Keep countdown for urgency but use softer language.

## Examples

**Example 1: Standard live webinar**
User: "Build a webinar registration page for my free training: 'How to Create AI Videos for YouTube' on April 20 at 7pm EST, I'm promoting HeyGen"
Action: event with real date, presenter=user, affiliate_product=HeyGen, live countdown to April 20, purple theme, full page with teaser of HeyGen in the "what you'll learn" section.

**Example 2: Evergreen training**
User: "Create an evergreen webinar registration page for a training about email marketing, I'll promote Klaviyo"
Action: countdown_mode=evergreen, topic="email marketing", affiliate_product=Klaviyo, always-on urgency, blue theme.

**Example 3: With full details**
User: "Webinar reg page — 'The AI Content Strategy That Gets 10K Visitors/Month', Jane Smith presenting, May 5 at 6pm PT, 4-part agenda, promoting Semrush"
Action: Full page with Jane Smith's bio, custom agenda, live countdown to May 5, Semrush teased in agenda item 3, purple theme.

**Example 4: Chained from S1**
User: "Build a webinar registration page around this product"
Context: S1 returned HeyGen as recommended_program
Action: affiliate_product=HeyGen from S1, auto-generate event title based on HeyGen's main use case, ask for presenter name and event date, then build full page.

## References

- `references/conversion-principles.md` — Event page conversion principles, urgency mechanics, form optimization. Read in Step 2.
- `shared/references/ftc-compliance.md` — Event-specific FTC disclosure text. Read in Step 4.
- `shared/references/affitor-branding.md` — Footer attribution HTML. Read in Step 4.
- `shared/references/affiliate-glossary.md` — Terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `email-drip-sequence` (S5) — registrants enter pre-webinar email sequence
- `bio-link-deployer` (S5) — registration page URL for link hub
- `github-pages-deployer` (S5) — HTML file to deploy

### Fed By

- `affiliate-program-search` (S1) — affiliate product to feature in the webinar
- `grand-slam-offer` (S4) — offer framing for the webinar pitch
- `value-ladder-architect` (S4) — webinar as a rung in the value ladder

### Feedback Loop

- `conversion-tracker` (S6) measures registration rate and webinar-to-affiliate conversion → optimize registration page and webinar content

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
  skill_slug: "webinar-registration-page"
  stage: "landing"
  timestamp: string
  suggested_next:
    - "email-drip-sequence"
    - "bio-link-deployer"
    - "conversion-tracker"
```
