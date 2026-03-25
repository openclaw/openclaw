---
name: conversion-tracker
description: >
  Set up affiliate conversion tracking with UTM parameters and link tagging. Triggers on:
  "set up tracking", "create UTM links", "track my affiliate links", "tracking pixels",
  "click attribution", "organize my links", "UTM parameters", "tag my links",
  "campaign tracking", "link tracking setup", "prepare for launch",
  "debug attribution", "tracking spreadsheet".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "analytics", "optimization", "tracking", "conversion"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S6-Analytics
---

# Conversion Tracker

Set up affiliate conversion tracking — generate UTM-tagged links, create link naming conventions, configure tracking pixel setup instructions, and build a tracking spreadsheet. Output is a Markdown tracking guide with a table of tagged links ready to deploy.

## Stage

S6: Analytics — The difference between amateur and professional affiliates. You can't optimize what you don't measure. After deploying content (S5), you need UTM-tagged links for every platform and content piece to know exactly which channel drives conversions.

## When to Use

- User is about to launch a campaign and needs tracking links
- User wants UTM-tagged links for different platforms
- User says "set up tracking", "create UTM links", "organize my affiliate links"
- User wants to track which content drives the most clicks and conversions
- User is preparing to run ads and needs consistent link tagging
- Chaining from S1 (product selected) → generate tracking links before creating content in S2-S5

## Input Schema

```yaml
product:
  name: string # REQUIRED — product name (e.g., "HeyGen")
  affiliate_url: string # REQUIRED — base affiliate link

platforms: # OPTIONAL — where content will be published
  - string # e.g., ["linkedin", "twitter", "blog", "email", "reddit"]
    # Default: ["blog", "twitter", "linkedin"]

campaign_name:
  string # OPTIONAL — campaign identifier (e.g., "q1-2026-ai-tools")
  # Default: auto-generated from product name + date

tracking_tool:
  string # OPTIONAL — "google_analytics" | "voluum" | "clickmagick"
  # | "manual_utm". Default: "manual_utm"

content_types: # OPTIONAL — types of content being created
  - string # e.g., ["blog_review", "social_post", "email", "landing_page"]
```

**Chaining context**: If S1 was run, pull `recommended_program.affiliate_url` and `recommended_program.name`. If S2-S5 outputs exist, use them to determine platforms and content types automatically.

## Workflow

### Step 1: Gather Product and Platform Info

Collect product name, affiliate URL, and target platforms. If not provided, default to blog + twitter + linkedin (the three most common affiliate channels).

### Step 2: Generate UTM-Tagged Links

For each platform × content-type combination, create a UTM-tagged URL:

- `utm_source`: platform name (e.g., `linkedin`, `twitter`, `blog`)
- `utm_medium`: content type (e.g., `social`, `article`, `email`)
- `utm_campaign`: campaign name (e.g., `heygen-q1-2026`)
- `utm_content`: specific content identifier (e.g., `review-post`, `cta-button`, `bio-link`)

Append UTM parameters to the affiliate URL. Handle URLs that already have query parameters (use `&` not `?`).

### Step 3: Create Link Naming Convention

Establish a consistent naming scheme:

```
{product}-{platform}-{content_type}-{variant}
```

Example: `heygen-linkedin-review-v1`

### Step 4: Build Tracking Setup Guide

Based on `tracking_tool`:

- **Google Analytics**: Event tracking setup, goal configuration, UTM report location
- **Voluum / ClickMagick**: Postback URL setup, conversion pixel placement
- **Manual UTM**: Google Sheets tracking template with columns for link, platform, clicks, conversions

### Step 5: Output Tracking Sheet

Present all links in a structured table with:

- Link name
- Platform
- Content type
- Full tagged URL
- Notes

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] UTM parameters correctly appended to all affiliate URLs
- [ ] No URL encoding errors in generated links
- [ ] Naming convention is consistent across all links
- [ ] All links are under URL length limits
- [ ] Setup guide steps match the recommended tracking tool

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
tracking:
  product: string
  campaign: string
  total_links: number

links:
  - name: string # e.g., "heygen-linkedin-review-v1"
    platform: string
    content_type: string
    url: string # full UTM-tagged URL
    utm_source: string
    utm_medium: string
    utm_campaign: string
    utm_content: string

naming_convention:
  pattern: string # e.g., "{product}-{platform}-{type}-{variant}"
  examples: string[]

setup_guide:
  tool: string
  steps: string[]
```

## Output Format

1. **Tracking Links Table** — Markdown table with all tagged links
2. **Naming Convention** — pattern + examples for consistency
3. **Setup Guide** — step-by-step instructions for the chosen tracking tool
4. **Next Steps** — what to do with these links (plug into S2-S5 content)

## Error Handling

- **No affiliate URL provided**: "I'll create the UTM structure and naming convention now. Replace `[YOUR_AFFILIATE_LINK]` with your actual affiliate URL when you have it."
- **URL already has UTM parameters**: "Your affiliate URL already has UTM parameters. I'll append additional tracking parameters without overwriting the existing ones."
- **Too many platform × content combinations (>20)**: "That's a lot of links. I'll generate the most important ones (one per platform) and provide the naming convention so you can create the rest."

## Examples

### Example 1: Simple blog + social setup

**User**: "Set up tracking for my HeyGen affiliate link (heygen.com/ref/abc123) on my blog and Twitter"
**Action**: Generate 4 links: blog-review, blog-comparison, twitter-post, twitter-thread. Each with proper UTM tags. Include Google Sheets tracking template.

### Example 2: Multi-platform campaign

**User**: "I'm launching a campaign for Semrush across LinkedIn, Twitter, Reddit, my blog, and email newsletter. Create all my tracking links."
**Action**: Generate 10+ links across all platforms and content types. Establish naming convention. Suggest Google Analytics goal setup for conversion tracking.

### Example 3: Chained from S1

**Context**: S1 found HeyGen with affiliate URL heygen.com/ref/abc123.
**User**: "Set up tracking for this before I start creating content."
**Action**: Pull product info from S1 output. Generate links for the user's likely content types (infer from S1 context). Prepare tracking sheet that S6.3 (performance-report) can use later.

## References

- `references/tracking-templates.md` — Google Sheets template, UTM parameter reference, platform-specific tracking notes, S6 feedback loop
- `shared/references/affiliate-glossary.md` — Definitions for tracking terms (EPC, CTR, conversion). Referenced in setup guide.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `affiliate-program-search` (S1) — top converting niches → search for more programs in winning niches
- `performance-report` (S6) — conversion data for reports
- `ab-test-generator` (S6) — conversion baselines for test evaluation

### Fed By

- `bio-link-deployer` (S5) — deployed link URLs to track
- `email-drip-sequence` (S5) — email links to track
- `landing-page-creator` (S4) — landing page conversions to track
- `github-pages-deployer` (S5) — deployed site to track

### Feedback Loop

- Conversion data feeds back to S1 Research (which programs convert best) and S4 Landing (which page elements convert) — closing the flywheel loop

```yaml
chain_metadata:
  skill_slug: "conversion-tracker"
  stage: "analytics"
  timestamp: string
  suggested_next:
    - "performance-report"
    - "ab-test-generator"
    - "affiliate-program-search"
```
