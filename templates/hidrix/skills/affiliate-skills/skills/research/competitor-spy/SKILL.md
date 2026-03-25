---
name: competitor-spy
description: >
  Reverse-engineer successful affiliate strategies from competitors.
  Use this skill when the user asks about spying on competitors, researching what
  other affiliates promote, analyzing competitor affiliate sites, understanding
  how top affiliates in a niche make money, or says "what programs does X promote",
  "how does [site] make money", "what affiliate strategy does this site use",
  "spy on competitor affiliates", "reverse engineer affiliate site", "copy what
  works in my niche", "who are the top affiliates in X niche", "what content
  gets traffic in my niche", "competitor affiliate analysis".
license: MIT
version: "1.0.0"
tags:
  ["affiliate-marketing", "research", "niche-analysis", "program-discovery", "competitive-analysis"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S1-Research
---

# Competitor Spy

Analyze competitor affiliate sites, YouTube channels, and social profiles to
surface which programs they promote, what content drives their traffic, and
which strategies are worth replicating. Outputs an actionable reverse-engineering
report so you can skip years of trial and error.

## Stage

This skill belongs to Stage S1: Research

## When to Use

- User wants to know what programs are working in a specific niche
- User has a competitor site/channel in mind and wants to understand their strategy
- User is entering a new niche and wants a shortcut to what works
- User wants to find underserved content gaps a competitor hasn't covered
- User asks "how do top affiliates in [niche] make money?"

## Input Schema

```
{
  competitor_url: string      # (optional) Direct URL to competitor site, channel, or profile
  niche: string               # (optional) Niche to analyze if no specific competitor given
  platform: string            # (optional) "blog" | "youtube" | "tiktok" | "twitter" | "newsletter"
  depth: string               # (optional, default: "standard") "quick" | "standard" | "deep"
  focus: string               # (optional) "programs" | "content" | "traffic" | "all"
}
```

## Workflow

### Step 1: Identify Competitors to Analyze

If `competitor_url` is provided, skip to Step 2.

If only `niche` is provided, find 3-5 top competitors:

1. `web_search "best [niche] affiliate sites"` — look for review/comparison sites
2. `web_search "[niche] review site affiliate"` — find review-first monetization models
3. `web_search "[niche] blog affiliate income report"` — income reports reveal programs
4. Note: YouTube — `web_search "youtube [niche] affiliate site:youtube.com"` to find channels

Pick 3 competitors that are clearly affiliate-driven (review pages, comparison tables,
"best X" content, Amazon links, affiliate disclaimers visible).

### Step 2: Identify Affiliate Programs They Promote

For each competitor site/channel:

**Method A — Link analysis:**

- `web_fetch [competitor_url]` and scan for outbound links
- Look for: `?ref=`, `?via=`, `/go/`, `aff_id=`, `?affiliate=`, `shareasale.com`,
  `impact.com`, `partnerstack.com`, `awin.com`, `cj.com`, `linktr.ee`
- These patterns indicate affiliate links

**Method B — Content analysis:**

- Look at their top content: "Best X", "X vs Y", "X Review", "X Alternatives"
- Every product featured prominently = likely affiliate relationship
- Products mentioned with a CTA button ("Try X Free", "Get X") = strong affiliate signal

**Method C — Disclosure scan:**

- Search page for "affiliate", "commission", "sponsored", "partner" disclosures
- These legally required disclosures often appear at top/bottom and reveal programs

**Method D — Income reports (if available):**

- `web_search "[site name] income report affiliate"` — some affiliates publish earnings
- `web_search "[creator name] how I make money affiliate"` — creator transparency posts

Extract for each program found: name, estimated prominence (primary/secondary/mentioned),
content type promoting it, and whether it appears on list.affitor.com.

### Step 3: Analyze Their Content Strategy

For each competitor, extract:

**Content patterns:**

- Most common formats: listicles ("10 best X"), comparisons ("X vs Y"), tutorials,
  reviews, roundups, case studies
- Average content depth: shallow (<1000 words), standard (1000-3000), deep (3000+)
- Publishing frequency: estimate from visible dates or `web_search "site:[domain] 2024"`
- Content freshness: are articles updated? When?

**Traffic indicators (from web search signals):**

- `web_search "site:[domain]"` — rough page count
- Search for their brand name — how much branded traffic/discussion?
- Look for "X review" queries in their content — review content = high buyer intent

**SEO and social signals:**

- Do they rank for "[product] review" terms? (indicates SEO strategy)
- Active social profiles linked from site? Which platforms?
- Do they have a newsletter/email list? (footer signup forms)

### Step 4: Find Content Gaps

Compare competitor content to what's NOT covered:

1. Products they promote but haven't done deep comparison posts for
2. Common user questions (from YouTube comments, Reddit threads, forums) they haven't answered
3. New product launches in the niche that competitors haven't covered yet
4. Angles competitors avoid (negative reviews, honest cons, "X is not for everyone")

Use `web_search "reddit [niche] [product] problems"` to find pain points no affiliate
has addressed honestly — these make high-converting, low-competition content.

### Step 5: Score Competitor Strategies

For each competitor, assess:

| Dimension              | Score (1-10) | Assessment                                                                   |
| ---------------------- | ------------ | ---------------------------------------------------------------------------- |
| Program Quality        | —            | Are they promoting high-commission recurring programs or low-margin one-off? |
| Content Quality        | —            | Shallow listicles vs. deep genuine reviews                                   |
| SEO Sophistication     | —            | Thin content vs. well-structured, keyword-targeted                           |
| Monetization Diversity | —            | One program vs. multiple revenue streams                                     |
| Replicability          | —            | How hard is it to do what they do, but better?                               |

Higher replicability score = easier to beat them.

### Step 6: Build the Intelligence Report

Synthesize findings into a 3-part report:

1. **Programs worth stealing** — top programs their strategy validates
2. **Content formats that clearly work** — patterns worth replicating
3. **Gaps to exploit** — angles they've missed that you can own

### Step 7: Self-Validation

Before presenting output, verify:

- [ ] Confidence levels match evidence strength (confirmed = affiliate link found, likely = brand mention pattern, possible = inferred)
- [ ] Programs cross-checked on list.affitor.com where possible
- [ ] Replicability score accounts for barriers (domain authority, team size)
- [ ] No hallucinated competitor data — all claims traceable to web_search results

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```
{
  output_schema_version: "1.0.0"  # Semver — bump major on breaking changes
  competitors_analyzed: [
    {
      url: string                   # Competitor URL
      niche: string                 # Their niche focus
      estimated_programs: string[]  # Programs they appear to promote
      top_content_formats: string[] # ["listicle", "comparison", "tutorial"]
      estimated_traffic: string     # "low" | "medium" | "high" (inferred from signals)
      replicability_score: number   # 1-10
    }
  ]
  validated_programs: [
    {
      name: string           # "ConvertKit"
      promoted_by: string[]  # Which competitors promote it
      confidence: string     # "confirmed" | "likely" | "possible"
      list_affitor_url: string | null  # If found on list.affitor.com
    }
  ]
  content_gaps: string[]     # Opportunities to fill
  recommended_programs: string[]  # Top programs to prioritize based on analysis
  recommended_next_skill: string  # "affiliate-program-search"
}
```

## Output Format

```
## Competitor Intelligence Report: [Niche]

### Competitors Analyzed

| Competitor | Programs Found | Content Focus | Replicability |
|-----------|---------------|---------------|---------------|
| [site1.com] | [Program A, B, C] | Best-of lists, comparisons | 7/10 |
| [site2.com] | [Program D, E] | YouTube reviews | 8/10 |

---

### Programs Worth Promoting (Validated by Competitors)

| Program | Promoted By | Evidence | On list.affitor.com |
|---------|------------|----------|---------------------|
| [Program A] | [2 competitors] | Prominent CTA buttons, review posts | Yes |
| [Program B] | [1 competitor] | Income report mention | Check manually |

---

### Content Formats That Work in This Niche

1. **[Format 1]:** [What it is, why it works, example from competitor]
2. **[Format 2]:** [...]
3. **[Format 3]:** [...]

---

### Content Gaps You Can Exploit

1. **[Gap 1]:** [What's missing, why it's valuable, how to fill it]
2. **[Gap 2]:** [...]
3. **[Gap 3]:** [...]

---

## Next Steps

1. Run `affiliate-program-search` to evaluate the top validated programs
2. Run `commission-calculator` to compare earnings potential across programs
3. Start with the highest-gap content angle: [Gap 1] for [Program A]
```

## Error Handling

- **Competitor URL blocked or paywalled:** Fall back to web_search signals (Google cache,
  SimilarWeb mentions, blog posts about the competitor). Note limitations in report.
- **No obvious affiliate links found:** Competitor may use native ads or direct sponsorships
  instead. Flag this and look for brand mention patterns.
- **Niche too broad:** Ask user to narrow to a sub-niche or pick one platform to focus analysis on.
- **No competitors found:** Niche may be too new or too narrow. Broaden one step and re-search.
  If still empty, this itself is a signal — could be a gap opportunity.
- **Competitor is a large media company (Forbes, Wirecutter):** Scale down — these aren't
  replicable. Find indie affiliate sites instead (`web_search "[niche] best [product] blog"`).

## Examples

**Example 1:**
User: "Spy on what affiliate programs income school recommends"
→ web_fetch incomeschool.com, look for affiliate disclosures and outbound links
→ Find: Bluehost, Ezoic, Rank Math, Jasper — extract with confidence levels
→ Map to list.affitor.com programs
→ Output intelligence report with content gaps in their niche

**Example 2:**
User: "What affiliate strategy do top YouTubers use in the AI tools niche?"
→ Find 3-5 AI tools YouTubers via web_search
→ Analyze video descriptions for affiliate links (common pattern: "links below")
→ Extract: most promote 5-10 tools consistently, heavy on comparison content
→ Identify gap: no one doing "best AI tools for [specific job role]" content

**Example 3:**
User: "I'm entering the email marketing niche, help me spy on competitors"
→ Find competitors: emailtooltester.com, emailvendorselection.com, etc.
→ Extract programs: ConvertKit, ActiveCampaign, GetResponse, Brevo
→ Content gap: all sites focus on features, none do "email marketing ROI by industry"
→ Recommend: start with ConvertKit (recurring, high commission), fill the ROI gap

## References

- `references/list-affitor-api.md` — validate found programs on list.affitor.com
- `shared/references/affiliate-glossary.md` — affiliate link pattern reference
- `shared/references/ftc-compliance.md` — understanding competitor disclosures
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `viral-post-writer` (S2) — competitor gaps reveal content opportunities
- `purple-cow-audit` (S1) — competitive landscape for product evaluation
- `grand-slam-offer` (S4) — competitive gaps to exploit in offers
- `bonus-stack-builder` (S4) — what competitors' affiliates offer (gaps to exploit)
- `category-designer` (S8) — competitive landscape to differentiate from

### Fed By

- `performance-report` (S6) — your performance data vs competitors
- `seo-audit` (S6) — ranking data showing where competitors outrank you

### Feedback Loop

- Performance comparisons from S6 reveal where competitor strategies outperform → focus spy analysis on their winning tactics

```yaml
chain_metadata:
  skill_slug: "competitor-spy"
  stage: "research"
  timestamp: string
  suggested_next:
    - "purple-cow-audit"
    - "grand-slam-offer"
    - "affiliate-blog-builder"
```
