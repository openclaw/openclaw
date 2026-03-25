# Landing Page Conversion Principles

## AIDA Framework

Every landing page follows AIDA — Attention, Interest, Desire, Action:

1. **Attention** (Hero section, above the fold)
   - Bold headline addressing the visitor's pain point
   - Subheadline with the product as the solution
   - Primary CTA button visible without scrolling
   - Time limit: you have 3-5 seconds to hook the reader

2. **Interest** (Feature/benefit section)
   - Show what the product does — features framed as benefits
   - Use a 3-column grid for scannability
   - "What" → "So what?" Every feature needs a benefit translation
   - Example: "AI video generation" → "Create professional videos in 5 minutes instead of 5 hours"

3. **Desire** (Social proof + pricing)
   - Testimonials, ratings, user counts, logos
   - Pricing that feels like a deal (anchor with higher comparison)
   - "Who is this for?" section — let the reader self-identify
   - Comparison table if multiple products

4. **Action** (CTA sections — minimum 3 per page)
   - Primary CTA: above the fold (hero)
   - Secondary CTA: after features/benefits
   - Final CTA: bottom of page, after all objections handled
   - Every CTA should be a button, not just a link

## Above-the-Fold Rules

The hero section is the most important part of the page. It must contain:

- **Headline**: 6-12 words, addresses the visitor's goal or pain
- **Subheadline**: 15-25 words, introduces the product as the solution
- **Primary CTA button**: high-contrast color, action verb ("Get Started", "Try Free", "Start Saving")
- **Trust signal**: one proof point (rating, user count, "No credit card required")
- **Visual**: product screenshot, hero image, or clean illustration

What to AVOID above the fold:

- Navigation menus (this is a landing page, not a website)
- Multiple competing CTAs
- Walls of text
- Generic stock photos

## CTA Button Design

- **Color**: High contrast against background. Don't match the page palette — break it.
- **Text**: Action verb + benefit. "Start My Free Trial" > "Submit". "Get 30% Off" > "Learn More".
- **Size**: Minimum 44px height (mobile touch target). Desktop: 48-56px.
- **Spacing**: Generous padding (16px 32px minimum). White space around the button.
- **Repetition**: Same CTA text throughout the page for consistency.

## Trust Signals

Include at least 2 of these:

- Star ratings (★★★★★ 4.8/5)
- User/customer count ("Trusted by 50,000+ creators")
- Company logos ("Used by teams at...")
- Testimonial quotes with real names
- "Money-back guarantee" or "No credit card required"
- Security badges (if relevant)
- Press mentions ("Featured in TechCrunch")

## Social Proof Placement

- **Proof bar**: immediately below or inside the hero section
- **Testimonials**: after the features section (validates the claims)
- **Logos**: near the top for B2B, near the bottom for B2C

## Feature/Benefit Grid

Use a 3-column grid (stacks to 1-column on mobile):

```
[Icon/Emoji]          [Icon/Emoji]          [Icon/Emoji]
Feature Name          Feature Name          Feature Name
Benefit description   Benefit description   Benefit description
(2-3 sentences)       (2-3 sentences)       (2-3 sentences)
```

Rules:

- 3 features minimum, 6 maximum
- Each feature: name (bold) + 1-2 sentence benefit
- Use icons or emoji for visual anchoring
- Features should map to the reader's top 3 concerns

## FAQ Section

- 4-6 questions that address buying objections
- Questions people actually ask (check "People Also Ask" on Google)
- Always include: pricing, refund/guarantee, getting started, support
- Use an accordion/expandable pattern for scannability

## Comparison Page Specifics

For comparison (vs) pages:

- **Hero**: "[Product A] vs [Product B]: Which is right for you?"
- **Comparison table**: Feature rows, checkmarks/values, highlighted winner per row
- **Individual sections**: 200-300 words per product with pros/cons
- **Winner callout**: Clear recommendation with reasoning
- **Dual CTAs**: One for each product (primary product gets more prominent CTA)

## Mobile-First Rules

- 90%+ of social media referral traffic is mobile
- Stack all columns to single column below 768px
- CTA buttons must be full-width on mobile
- Font: minimum 16px body, 24px+ headings
- Touch targets: minimum 44x44px
- No hover-dependent interactions
- Test: can you read the headline and find the CTA within 3 seconds on a phone?

## Color Theming

Use CSS custom properties for easy theming:

```css
:root {
  --color-primary: #2563eb; /* CTA buttons, links */
  --color-primary-hover: #1d4ed8;
  --color-bg: #ffffff; /* Page background */
  --color-surface: #f8fafc; /* Section backgrounds */
  --color-text: #1e293b; /* Body text */
  --color-text-light: #64748b; /* Secondary text */
  --color-accent: #f59e0b; /* Stars, highlights */
  --color-border: #e2e8f0; /* Dividers */
}
```

The user provides a `color_scheme` and the AI maps it to these variables.

## Typography

- System font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- No external font loading (keeps the page self-contained and fast)
- Hierarchy: H1 (36-48px), H2 (28-32px), H3 (20-24px), body (16-18px)
- Line height: 1.6 for body text, 1.2 for headings
- Max content width: 720px for text, 1080px for full-width sections
