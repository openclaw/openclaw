---
name: how-to-tutorial-writer
description: >
  Write how-to guides and tutorials that naturally integrate affiliate product recommendations.
  Triggers on: "write a how-to guide", "tutorial for [task]", "step by step guide to [goal]",
  "how to [verb] with [product]", "write a tutorial blog post", "guide on how to [task]",
  "beginner guide to [topic]", "walkthrough for [product]", "write an educational article",
  "how do I [task] blog post", "write a tutorial that promotes [product]".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "blogging", "seo", "content-writing", "tutorial", "how-to"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S3-Blog
---

# How-To Tutorial Writer

Write practical, step-by-step tutorial blog posts that solve a real reader problem and naturally recommend affiliate products as the best tool for the job. Uses the "problem → solution → tool" pattern: establish what the reader wants to do, show them exactly how to do it, and position the affiliate product as the right instrument for each step.

## When to Use

- User wants to create educational content that drives affiliate conversions indirectly
- User says "how to", "tutorial", "guide", "walkthrough", "step by step"
- User wants to rank for "how to [task]" keywords (high traffic, lower competition than "best" keywords)
- User has a product that is best understood through demonstration, not just description
- User wants to build authority and trust in a niche before making a sale

## Workflow

### Step 1: Define the Tutorial Goal

Parse the request to identify:

- **The task**: what the reader wants to accomplish (e.g., "create AI videos for YouTube")
- **The tool**: which affiliate product enables the task (e.g., HeyGen)
- **The audience**: who is asking this question (beginner / intermediate / advanced)
- **The end state**: what the reader will have built or achieved by the end

If the task is vague ("write a tutorial about HeyGen"), default to the most popular use case for that tool — search for it: `"[product name] tutorial" OR "how to use [product name]"` — pick the highest-traffic query.

**Tutorial types** — detect from user's phrasing:
| Signal | Type | Format |
|---|---|---|
| "How to get started", "beginners guide", "first time" | `quickstart` | 5-8 steps, 1,500-2,000 words |
| "Step by step", "complete guide", "full tutorial" | `deep-dive` | 8-15 steps, 2,500-3,500 words |
| "How to [specific feature]" | `feature-focus` | 5-8 steps on one feature, 1,500-2,000 words |
| "How to [goal] without [product]" → redirect to product | `problem-solution` | 6-10 steps, 2,000-2,500 words |

### Step 2: Research the Tutorial Content

Use `web_search` to gather:

1. The actual step-by-step process for accomplishing the task
2. Common mistakes or gotchas beginners encounter
3. Official documentation or help articles for the product
4. What the top-ranking tutorials already cover (identify gaps)

Search queries:

- `"how to [task] with [product]"` — understand existing guides
- `"[product] tutorial [year]"` — find current instructions
- `"[product] [feature] settings"` — get accurate step names
- `"[task] mistakes beginners make"` — find pain points to address

**Content accuracy rule**: Never invent product UI details. If unsure about a specific button name or menu path, describe the action generically ("navigate to the settings section") rather than naming something that may be wrong.

### Step 3: Plan the Tutorial Structure

Map every section before writing. A well-structured tutorial follows this flow:

**What readers need before starting (Prerequisites):**

- Account requirements (free plan vs. paid tier needed for tutorial steps)
- Technical requirements
- Assets they should have ready (images, scripts, data)

**The steps themselves:**

- Each step = one atomic action (not a cluster of actions)
- Steps should be numbered, not just bulleted
- Each step has: action verb headline + explanation + expected result
- Decision points get callout boxes: "If you see X, do Y instead"

**Affiliate integration points** (natural, not forced):

1. In the Prerequisites section: "You'll need a [Product] account. [Sign up free here →](url)"
2. At the step where the product's key feature is used: contextual CTA
3. After showing the final result: "You just did X with [Product]. Here's what else it can do: [affiliate CTA]"
4. In the "Next Steps" section at the end

**Rule**: Never interrupt a step sequence with a hard sell. CTAs belong at natural pause points — before the reader starts, after they finish a major phase, and at the very end.

### Step 4: Write the Full Tutorial

**Title formula:**

- `How to [Task] with [Product]: Step-by-Step Guide ([Year])`
- `How to [Task]: A Beginner's Guide Using [Product]`
- `[Goal]: How to [Task] in [N] Steps (Even If You're New to [Topic])`

**Introduction (150-200 words):**

- Open with the reader's problem/desire (not with "In this tutorial...")
- State the end result: "By the end, you'll have [specific output]"
- Mention how long it takes and what level of experience is needed
- One-sentence product intro: "[Product] is what makes this possible — here's how to use it."
- Affiliate CTA if they need to sign up before starting

**Prerequisites section:**

```
**What you need before starting:**
- A [Product] account (free plan works / Pro plan required for [specific feature])
  → [Create your free account →](affiliate_url)
- [Any other required tool/asset/knowledge]
- Estimated time: [X minutes]
```

**Step-by-Step Section:**
Write each step as:

```
## Step [N]: [Action Verb] + [What You're Doing]

[2-4 sentence explanation of what this step does and why it matters]

1. [Specific sub-action with exact UI element names where known]
2. [Next sub-action]
3. [Continue...]

**You should see:** [description of what the expected result looks like]

> **Note:** [Optional callout for a common mistake or alternative path]
```

**Result/Output Section:**
After all steps, show what the reader has built:

- Describe the final output in concrete terms
- Include what they can do with it now
- Contextual affiliate CTA: "Now that you've [achieved X], you can use [Product]'s [feature] to take it further."

**Troubleshooting Section** (optional, high SEO value):
3-5 common issues readers might hit:

- "Error: [X]" → "This usually means [Y]. Fix it by [Z]."
- "Step 4 doesn't work if [condition]" → "Instead, try [alternative]."

**Next Steps Section:**

- What to do with the result
- Related features of the product to explore next
- Related tutorials (if user has other content)
- Final strong affiliate CTA

**FAQ Section (4-6 questions):**

- "Do I need a paid plan for [product] to follow this tutorial?"
- "How long does [task] take?"
- "Can I do this without [product]?"
- "Is [product] free to use for [task]?"
- "What should I do if [common problem]?"

### Step 5: Format Output

**Part 1: SEO Metadata**

```
---
SEO METADATA
---
Title: [title]
Slug: how-to-[task-slug]
Meta Description: [150-160 chars — include "how to", the task, and product name]
Target Keyword: how to [task] with [product]
Secondary Keywords: [product] tutorial, [task] guide, how to [task] [year], [product] for beginners
Word Count: [actual]
Format: how-to
Steps: [N]
---
```

**Part 2: Full Article**
Complete markdown ready to publish.

**Part 3: Supplementary Data**

- FAQ schema questions/answers
- Screenshot suggestions (one per major step)
- Products featured with affiliate URLs
- Video script outline (optional — if user wants to turn this into a YouTube tutorial)

## Input Schema

```yaml
task:                       # REQUIRED — what the reader wants to accomplish
  description: string       # e.g., "create an AI avatar video for YouTube"
  goal: string              # The end state — "a published YouTube video with AI avatar"

product:                    # REQUIRED — the affiliate tool that enables the task
  name: string
  description: string
  reward_value: string
  url: string               # Affiliate link
  reward_type: string
  cookie_days: number
  tags: string[]

tutorial_type: string       # OPTIONAL — "quickstart" | "deep-dive" | "feature-focus" | "problem-solution"
                            # Default: auto-detected from task complexity

audience_level: string      # OPTIONAL — "beginner" | "intermediate" | "advanced"
                            # Default: "beginner" (wider audience)

supporting_tools: object[]  # OPTIONAL — other tools used alongside the primary product
  - name: string
    url: string
    purpose: string         # What role this tool plays in the tutorial

target_keyword: string      # OPTIONAL — override default "how to [task]" keyword

tone: string                # OPTIONAL — "conversational" | "technical"
                            # Default: "conversational"

include_video_outline: boolean  # OPTIONAL — generate a YouTube video script outline alongside
                                # Default: false
```

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] Steps are numbered (not bulleted) and atomic — one action per step
- [ ] Prerequisites section is present with requirements and time estimate
- [ ] FTC disclosure appears after title
- [ ] No invented UI details — describe generically if unsure
- [ ] CTA never interrupts a step sequence

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
article:
  title: string
  slug: string
  meta_description: string
  target_keyword: string
  format: "how-to"
  tutorial_type: string # quickstart | deep-dive | feature-focus | problem-solution
  content: string
  word_count: number
  steps:
    - number: number
      headline: string # Step heading
      affiliate_cta: boolean # Whether this step contains a CTA

products_featured:
  - name: string
    url: string
    role: string # "primary-tool" | "supporting-tool"
    reward_value: string
    cta_placement: string[] # Which sections contain CTAs for this product

seo:
  secondary_keywords: string[]
  faq_questions:
    - question: string
      answer: string
  screenshot_suggestions: # One per major step — high-value for tutorials
    - step: number
      description: string
      alt_text: string

video_outline: # Only if include_video_outline=true
  title: string
  hook: string # First 30 seconds script
  chapters:
    - timestamp: string # e.g., "0:00"
      title: string
  description_for_youtube: string
  tags: string[]
```

## Output Format

Present as three sections:

1. **SEO Metadata** — fenced block for copy-paste into CMS
2. **Article** — complete markdown, immediately publishable
3. **Supplementary** — FAQ schema, screenshot suggestions, affiliate URLs, optional video outline

Target word count: 1,500-3,500 words based on tutorial type. Quality over length — do not pad steps.

## Error Handling

- **Task too vague** ("tutorial about email marketing"): Ask: "What specific task should the tutorial walk through? For example: 'how to set up an automated welcome email sequence in Mailchimp'."
- **No product provided**: "Which product should this tutorial feature? If you don't have one in mind, I can suggest the best tool for [task]."
- **Product feature requires paid plan**: Note clearly in Prerequisites section and add affiliate CTA. Do not hide paid requirements.
- **Task not suited for a single tutorial** (too complex): "This task has multiple phases — I'll write a [quickstart] tutorial focused on [first phase]. Let me know if you want additional tutorials for the other phases."
- **Product UI has changed**: Use generic action descriptions where UI details are uncertain. Add note: "Screenshots may vary slightly from your current version of [Product]."

## Examples

**Example 1: Product-driven tutorial**
User: "Write a tutorial on how to create AI avatar videos with HeyGen"
Action: task="create AI avatar video", product=HeyGen, audience=beginner, tutorial_type=deep-dive, write 12-step guide targeting "how to create ai avatar video with heygen".

**Example 2: Goal-driven tutorial**
User: "Write a how-to guide for automating social media posts"
Action: web_search for best social media automation tool, present to user for affiliate selection (or auto-select if S1 already ran), write problem-solution tutorial targeting "how to automate social media posts".

**Example 3: Feature-specific tutorial**
User: "Tutorial on how to use Semrush keyword magic tool"
Action: task="find keywords with Semrush Keyword Magic Tool", tutorial_type=feature-focus, write focused 8-step guide, affiliate CTAs at start and end.

**Example 4: With video outline**
User: "Write a HeyGen tutorial that I can also use as a YouTube video script"
Action: Same as Example 1 but with include_video_outline=true, output includes full video description, chapter markers, and hook script.

## References

- `shared/references/ftc-compliance.md` — FTC disclosure text. Insert after title.
- `shared/references/affiliate-glossary.md` — Terminology reference.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Flywheel Connections

### Feeds Into

- `content-pillar-atomizer` (S2) — tutorial as pillar content to atomize into tips/clips
- `landing-page-creator` (S4) — tutorial product for landing page
- `internal-linking-optimizer` (S6) — new tutorial needs internal links

### Fed By

- `affiliate-program-search` (S1) — `recommended_program` product data
- `keyword-cluster-architect` (S3) — informational intent clusters for tutorial topics

### Feedback Loop

- `seo-audit` (S6) tracks tutorial rankings → identify which tutorial types and depths rank best

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
  skill_slug: "how-to-tutorial-writer"
  stage: "blog"
  timestamp: string
  suggested_next:
    - "content-pillar-atomizer"
    - "landing-page-creator"
    - "internal-linking-optimizer"
```
