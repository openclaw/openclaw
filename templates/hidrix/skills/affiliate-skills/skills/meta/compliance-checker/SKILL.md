---
name: compliance-checker
description: >
  Check affiliate content for FTC compliance and platform rules. Triggers on:
  "check my content for compliance", "FTC disclosure check", "is this legal",
  "review for compliance", "check affiliate disclosure", "am I FTC compliant",
  "audit my content", "compliance review", "legal check", "platform rules check",
  "check before publishing", "disclosure audit", "review my ad copy".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "meta", "planning", "compliance", "ftc", "disclosure"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S8-Meta
---

# Compliance Checker

Audit affiliate content for FTC compliance, platform-specific rules, and legal requirements. Checks disclosure placement, prohibited claims, endorsement guidelines, and platform policies. Output is a compliance scorecard with issues, severity, and fix suggestions.

## Stage

S8: Meta — The FTC has fined affiliates $4.2M+ for undisclosed endorsements. One missing disclosure can result in legal action, platform bans, or program termination. This skill is the safety net — run it on any content before publishing to catch compliance issues before they become problems.

## When to Use

- User wants to check content before publishing
- User asks about FTC rules or affiliate disclosure requirements
- User is unsure if their content is compliant
- User says "is this legal?", "do I need a disclosure?", "check my post"
- User is preparing content for a platform with strict ad policies (Facebook, Google)
- Chaining: run after any S2-S5 or S7 content-producing skill before publishing
- User wants to audit existing published content

## Input Schema

```yaml
content: string # REQUIRED — the content to check (text, markdown, or HTML)

content_type:
  string # REQUIRED — "social_post" | "blog" | "landing_page"
  # | "email" | "ad" | "video_script"

platform:
  string # OPTIONAL — "linkedin" | "twitter" | "reddit" | "facebook"
  # | "tiktok" | "youtube" | "google_ads" | "pinterest"
  # Platform-specific rules applied if provided

claims: # OPTIONAL — specific claims to verify
  - string # e.g., ["earn $10K/month", "guaranteed results"]
```

**Chaining context**: If content was produced by S2-S5 or S7 in the same conversation, pull it directly. The user should not have to paste content that was just generated.

## Workflow

### Step 1: Detect Affiliate Links

Scan content for:

- URLs with affiliate parameters (`ref=`, `aff=`, `partner=`, UTM tags)
- Shortened URLs (bit.ly, etc.) that may hide affiliate links
- Product mentions that imply a commercial relationship

### Step 2: Check FTC Disclosure

Read `shared/references/ftc-compliance.md` for rules. Check:

- **Presence**: Is there a disclosure? (required if any affiliate link exists)
- **Placement**: Is the disclosure before or near the affiliate link? (not buried at the bottom)
- **Clarity**: Is it clear to a reasonable consumer? ("affiliate link" is clear; "partner" alone is not)
- **Format by content type**:
  - Social post: `#ad` or `Affiliate link` visible without expanding
  - Blog: Disclosure in the opening paragraph, above the fold
  - Landing page: Medium disclosure above the fold
  - Email: Disclosure near the affiliate link
  - Ad: Platform-specific requirements

### Step 3: Check Prohibited Claims

Scan for:

- **Income claims**: "earn $X", "make money fast", "passive income guaranteed"
- **False urgency**: "only 3 left" (if not verifiable), "offer expires" (if no real deadline)
- **Health/medical claims**: unsubstantiated health benefits
- **Guaranteed results**: "guaranteed to work", "100% success rate"
- **Fake scarcity**: "limited spots" (if not actually limited)
- **Fake testimonials**: results that aren't typical without disclaimer

### Step 4: Check Platform Rules

If `platform` is provided, apply platform-specific rules:

- **Reddit**: Self-promotion rules (10:1 ratio), must disclose in post
- **Facebook/Instagram**: Branded Content tool, "Paid Partnership" label for ads
- **Google Ads**: Clear commercial intent, no misleading claims, landing page requirements
- **TikTok**: #ad or Paid Partnership toggle, no medical/financial advice claims
- **YouTube**: Verbal + written disclosure in first 30 seconds, "Includes paid promotion" checkbox

### Step 5: Score and Report

Rate compliance on three levels:

- **PASS**: No issues found
- **WARN**: Minor issues that should be fixed (e.g., disclosure placement could be better)
- **FAIL**: Critical issues that must be fixed before publishing (e.g., no disclosure at all)

### Step 6: Generate Fixes

For each issue, provide:

- What's wrong (specific quote from content)
- Why it matters (rule reference)
- How to fix it (specific replacement text)

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] All affiliate links in the content are detected and flagged
- [ ] Disclosure placement check matches platform-specific rules
- [ ] Prohibited claims identified with exact quotes from content
- [ ] Fix suggestions are copy-paste ready and preserve original tone
- [ ] Corrected content would pass a re-scan by this same skill

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
compliance:
  overall_score: string # "PASS" | "WARN" | "FAIL"
  disclosure_present: boolean
  disclosure_placement: string # "correct" | "needs_improvement" | "missing"
  prohibited_claims: number # count of issues found
  platform_issues: number # count of platform-specific issues

issues:
  - severity: string # "critical" | "warning" | "info"
    category: string # "disclosure" | "claims" | "platform" | "formatting"
    description: string # what's wrong
    quote: string # the problematic text
    fix: string # suggested replacement

corrected_content: string # full content with all fixes applied
```

## Output Format

1. **Compliance Scorecard** — overall score, disclosure status, issue counts
2. **Issues Found** — table with severity, category, description, and fix
3. **Corrected Content** — the full content with all issues fixed (copy-paste ready)
4. **Platform Notes** — any platform-specific requirements not yet addressed

## Error Handling

- **No content provided**: "Paste the content you want me to check, or tell me which skill output to review. I'll check it for FTC compliance and platform rules."
- **Content has no affiliate links**: "No affiliate links detected. FTC disclosure is only required for content with material connections (affiliate links, sponsored content, gifted products). Your content looks clean."
- **Unknown platform**: "I don't have specific rules for [platform]. I'll check general FTC compliance. For platform-specific rules, check the platform's advertising policy page."

## Examples

### Example 1: Social post with missing disclosure

**User**: "Check this tweet: 'Just tried HeyGen and it's incredible for creating AI videos. Use my link to get 10% off: heygen.com/ref/abc123'"
**Action**: FAIL — no FTC disclosure. Fix: Add `#ad` before or after the link. Output corrected tweet with disclosure.

### Example 2: Blog post with buried disclosure

**User**: [Pastes a 1000-word blog review with disclosure only in the footer]
**Action**: WARN — disclosure present but buried at bottom. Fix: Move disclosure to opening paragraph. Also check for income claims, link attributes (`rel="nofollow sponsored"`).

### Example 3: Facebook ad with income claim

**User**: "Check this ad: 'I made $5,000 last month with this one tool. You can too! Click here to start earning.'"
**Action**: FAIL — (1) income claim without typicality disclaimer, (2) no FTC disclosure, (3) Facebook requires Paid Partnership label. Output fixes for all three issues.

## References

- `shared/references/ftc-compliance.md` — FTC affiliate disclosure requirements. Read in Step 2.
- `shared/references/affitor-branding.md` — Branding guidelines. Referenced for page outputs.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue protection**: The FTC has fined affiliates $4.2M+ for undisclosed endorsements. A single violation can result in program termination (losing ALL commissions), platform bans, or legal action. Compliance isn't about making money — it's about not losing the money you've already earned
- **Benchmark**: Amazon Associates terminates 10,000+ affiliate accounts per year for policy violations. One missing disclosure on one post can end your entire affiliate business overnight
- **Key metric to track**: Compliance score across ALL your published content. Target: 100% PASS. Any FAIL = fix before publishing. Any WARN = fix within 48 hours

### Do This Right Now (15 min)

1. **Fix all FAIL issues immediately** — do not publish until every critical issue is resolved
2. **Fix WARN issues** — update disclosure placement, fix any claim language
3. **Copy the Corrected Content** from the output and replace your original content
4. **Audit your top 5 existing posts** — run this skill on your most-trafficked affiliate content to ensure they're compliant

### Track Your Results

Run this skill monthly on all new content before publishing. Keep a compliance log — if the same issue appears 3+ times, update your content creation workflow to prevent it at the source (e.g., add FTC disclosure to your post template).

> **Next step — copy-paste this prompt:**
> "Plan my entire affiliate funnel from research to revenue" → runs `funnel-planner`

## Flywheel Connections

### Feeds Into

- All content skills (S2-S5, S7) — compliance status acts as a pass/fail gate before publishing

### Fed By

- All content-producing skills — content to check for compliance
- `landing-page-creator` (S4) — landing pages to audit for FTC compliance
- `email-drip-sequence` (S5) — emails to check for disclosure

### Feedback Loop

- Compliance issues found repeatedly in specific content types → flag to the relevant skill for structural improvement

```yaml
chain_metadata:
  skill_slug: "compliance-checker"
  stage: "meta"
  timestamp: string
  suggested_next:
    - "self-improver"
    - "funnel-planner"
```
