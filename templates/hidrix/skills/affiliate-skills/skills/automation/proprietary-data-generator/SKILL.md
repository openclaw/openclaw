---
name: proprietary-data-generator
description: >
  Create original surveys, benchmarks, and aggregated data nobody else has. Automate data collection
  for content moats.
  Triggers on: "create original data", "proprietary data", "survey design", "benchmark study",
  "original research", "data-driven content", "create a survey", "industry benchmark",
  "aggregated data", "unique data", "first-party data", "data moat",
  "generate research data", "create a study", "original statistics",
  "data nobody else has", "competitive data advantage".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "automation", "scaling", "workflow", "data", "original-research"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S7-Automation
---

# Proprietary Data Generator

Create original surveys, benchmarks, and aggregated data that nobody else has. Proprietary data is the ultimate content moat — competitors can copy your writing style but they can't copy YOUR data. Automates the design and execution framework for data collection that feeds unique content angles.

## Stage

S7: Automation & Scale — Generating data at scale requires automation. This skill designs the collection system, not just one data point. Creates repeatable data assets that compound over time.

## When to Use

- User wants to create content that can't be replicated by competitors
- User asks about "original research", "surveys", "benchmarks", "proprietary data"
- User says "data moat", "unique data", "first-party data", "original statistics"
- After `content-moat-calculator` identifies the need for differentiated content
- User wants to build authority through data-driven content
- User wants to create linkable assets that earn backlinks naturally

## Input Schema

```yaml
niche:
  string # REQUIRED — topic area for data collection
  # e.g., "AI video tools", "affiliate marketing"

data_type:
  string # OPTIONAL — "survey" | "benchmark" | "aggregation" | "case_study"
  # Default: recommend based on niche and resources

audience_access:
  string # OPTIONAL — how you can reach respondents
  # e.g., "email list of 500", "Reddit community", "Twitter followers"
  # Default: suggest options

budget:
  string # OPTIONAL — "zero" | "low" ($0-100) | "medium" ($100-500) | "high" ($500+)
  # Default: "zero"

goal:
  string # OPTIONAL — "content_moat" | "backlink_magnet" | "authority" | "lead_gen"
  # Default: "content_moat"
```

**Chaining from S3 content-moat-calculator**: Use `competitive_advantages` to identify data moat opportunities.

## Workflow

### Step 1: Identify Data Opportunity

Analyze the niche for data gaps:

1. `web_search`: `"[niche] statistics 2025" OR "[niche] survey" OR "[niche] benchmark"` — what data already exists?
2. Identify gaps: what questions does the industry ask that nobody has answered with data?
3. `web_search`: `"[niche] reddit" "I wish I knew" OR "does anyone know"` — find unmet data needs

### Step 2: Design Data Collection

Based on `data_type` (or recommend the best fit):

**Survey Design:**

- 8-12 questions (shorter = higher completion)
- Mix: 70% multiple choice, 20% scale (1-5), 10% open-ended
- One "surprising" question that will generate headline-worthy data
- Target sample size: 100+ for credibility
- Distribution plan: where and how to reach respondents

**Benchmark Study:**

- Define metrics to measure (3-5)
- Data sources: public data, API calls, manual collection
- Collection methodology: how often, what tools
- Comparison framework: how to present findings

**Data Aggregation:**

- Sources to aggregate from (public databases, APIs, web scraping targets)
- Aggregation logic: how to combine and normalize
- Update frequency: one-time or recurring
- Visualization plan

**Case Study Collection:**

- Template for collecting stories (5-7 structured questions)
- Outreach template for requesting case studies
- Anonymization rules
- Minimum viable sample: 10+ cases

### Step 3: Create Collection Assets

Produce ready-to-use assets:

1. **Survey questions** (if survey) — complete question list with answer options
2. **Collection template** — spreadsheet structure or form layout
3. **Outreach template** — email/message to recruit respondents
4. **Data analysis plan** — how to turn raw data into insights
5. **Content plan** — how to present findings (blog post, infographic, report)

### Step 4: Design Automation

Create a repeatable system:

- Schedule: when to collect data (monthly, quarterly, annually)
- Tools: recommended platforms (Google Forms, Typeform, Airtable)
- Automation: how to automate collection and reporting
- Update process: how to refresh and republish with new data

### Step 5: Self-Validation

- [ ] Data gap is real (verified by search — nobody else has this data)
- [ ] Sample size is realistic given audience access
- [ ] Questions are unbiased and well-structured
- [ ] Collection method is feasible with stated budget
- [ ] Output content plan is specific (not just "write a blog post")
- [ ] Data is ethically collected (no scraping private data, survey has consent)

## Output Schema

```yaml
output_schema_version: "1.0.0"
proprietary_data:
  niche: string
  data_type: string
  data_gap: string # What data doesn't exist yet
  headline_potential: string # The "surprising finding" angle

  collection:
    method: string
    sample_target: number
    tools: string[]
    timeline: string
    budget_needed: string

  assets:
    survey_questions: object[] # If survey type
    collection_template: string # Template description
    outreach_template: string # Recruitment message
    analysis_plan: string

  content_outputs: # Content to create from the data
    - type: string # "blog" | "infographic" | "report" | "social"
      title: string
      skill_to_use: string # Which skill creates this content

  data_assets: string[] # Moat strengtheners for chaining

chain_metadata:
  skill_slug: "proprietary-data-generator"
  stage: "automation"
  timestamp: string
  suggested_next:
    - "affiliate-blog-builder"
    - "content-pillar-atomizer"
    - "content-moat-calculator"
```

## Output Format

```
## Proprietary Data Plan: [Niche]

### The Data Gap
**Nobody has answered:** [the question]
**Why it matters:** [why people care]
**Headline potential:** "[Surprising finding template]"

### Collection Design

**Type:** [Survey / Benchmark / Aggregation / Case Study]
**Target sample:** XX responses
**Timeline:** X weeks
**Budget:** $XX
**Tools:** [tools list]

### Survey Questions (or Collection Template)
1. [Question] — [answer type] — [why this question]
2. [Question] — [answer type] — [why this question]
...

### Outreach Template
Subject: [subject line]
[email/message body]

### Content Plan (what to publish from this data)
1. **Blog post:** "[Title]" → build with `affiliate-blog-builder`
2. **Social thread:** Key findings → atomize with `content-pillar-atomizer`
3. **Lead magnet:** Full report PDF → distribute with `squeeze-page-builder`

### Automation Schedule
- **Collection:** [frequency]
- **Analysis:** [when after collection]
- **Publication:** [when after analysis]
- **Update:** [when to re-run with fresh data]
```

## Error Handling

- **No niche provided**: "Tell me your niche and I'll find data gaps nobody else is filling."
- **No audience access**: Suggest free distribution channels: Reddit, Twitter, niche forums, ProductHunt. "You don't need an email list — Reddit alone can drive 100+ survey responses."
- **Zero budget**: Design everything with free tools (Google Forms, Google Sheets, manual aggregation). "The best proprietary data costs $0 — just your time and curiosity."
- **Niche already well-researched**: Dig deeper. "The broad stats exist, but nobody has [specific angle]. Let's own that."

## Examples

**Example 1:** "I want original data about AI video tools"
→ Design survey: "AI Video Tools Usage Survey 2025" — 10 questions about which tools, satisfaction, spend, use cases. Distribute on Reddit r/aivideo, Twitter, LinkedIn. Target 150 responses. Content plan: "State of AI Video 2025" blog post + infographic.

**Example 2:** "Create a benchmark for affiliate marketing earnings"
→ Aggregate public data from case studies, combine with original survey. Monthly recurring data collection. "Affiliate Marketing Earnings Benchmark Q1 2025."

**Example 3:** "Data moat for my content strategy" (after content-moat-calculator)
→ Identify that competitors have generic content but NO original data. Design case study collection: "How 50 Affiliate Marketers Made Their First $1,000." Instant authority.

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: Original data content earns 5-10x more backlinks than generic content. Backlinks → higher domain authority → higher rankings for ALL your affiliate pages. One original data post can increase total site traffic by 20-50% over 6 months
- **Benchmark**: Data-driven blog posts get 2x more shares and 3x more backlinks than opinion posts. "State of [Industry]" posts are the most linked-to content format in B2B niches
- **Key metric to track**: Backlinks earned by the data content (check via Ahrefs, Semrush, or Google Search Console). Secondary: organic traffic increase to ALL affiliate pages (rising tide lifts all boats)

### Do This Right Now (15 min)

1. **Launch the survey or start data collection TODAY** — don't wait for the "perfect" survey. 80% good is enough to start
2. **Post the survey link** in 3 places immediately: your email list, one relevant subreddit, and one social platform
3. **Set a 2-week deadline** for data collection — urgency drives responses
4. **Pre-write the blog post outline** using the Content Plan section — so you're ready to publish the moment data comes in

### Track Your Results

After data collection: publish the findings as a blog post with `affiliate-blog-builder`. After 30 days: how many backlinks did the data post earn? After 90 days: did organic traffic to your money pages increase? If yes, plan your next data collection round — proprietary data compounds.

> **Next step — copy-paste this prompt:**
> "Write a blog post presenting my original research findings about [topic]" → runs `affiliate-blog-builder`

## Flywheel Connections

### Feeds Into

- `affiliate-blog-builder` (S3) — unique data angles for articles nobody else can write
- `content-pillar-atomizer` (S2) — data findings to atomize across platforms
- `content-moat-calculator` (S3) — proprietary data IS a moat strengthener

### Fed By

- `content-moat-calculator` (S3) — identifies need for differentiated content
- `performance-report` (S6) — performance data to aggregate

### Feedback Loop

- Track backlinks and citations of your data → identify which data points get referenced most → double down on those angles in next collection

## References

- `shared/references/case-studies.md` — Real data-driven success examples
- `shared/references/flywheel-connections.md` — Master connection map
