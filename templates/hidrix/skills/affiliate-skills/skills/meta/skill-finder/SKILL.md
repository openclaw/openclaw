---
name: skill-finder
description: >
  Find the right Affitor skill for your goal. Triggers on:
  "which skill should I use", "find me a skill", "what skills are available",
  "help me choose a skill", "skill for SEO", "skill for email", "explore skills",
  "I'm new to Affitor", "what can Affitor do", "search skills",
  "skill for blog writing", "skill for landing pages", "skill for analytics".
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing", "meta", "planning", "compliance", "discovery", "skill-search"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: affitor
  version: "1.0"
  stage: S8-Meta
---

# Skill Finder

Search and discover Affitor skills by task, stage, keyword, or natural language goal. Returns a ranked list of matching skills with descriptions, input requirements, and recommended next steps. Output is a concise Markdown guide.

## Stage

S8: Meta — The entry point to the entire Affitor ecosystem. New users don't know what's available. Experienced users forget skill names. Skill Finder bridges the gap — it reads the registry, matches intent to capability, and recommends the fastest path to the user's goal.

## When to Use

- User is new to Affitor and asks "what can I do?" or "where do I start?"
- User describes a goal but doesn't name a specific skill
- User wants to find skills by stage (e.g., "what analytics skills exist?")
- User asks "which skill helps with [topic]?"
- User says anything like "find skill", "search skill", "explore skills"
- Chaining: recommended as the first skill for new users before S1-S7

## Input Schema

```yaml
query:
  string # REQUIRED — natural language: "I want to write a blog review"
  # or "what skills help with SEO?" or "analytics skills"
stage_filter:
  string # OPTIONAL — filter by stage: research | content | blog | landing
  # | distribution | analytics | automation | meta
goal:
  string # OPTIONAL — broader goal: "first commission" | "scale to 1k"
  # | "optimize conversions" | "automate my workflow"
```

## Workflow

### Step 1: Load Skill Catalog

Read `registry.json` from the repository root (or from conversation context if already loaded). Parse all skills with their stage, name, slug, and description.

### Step 2: Match Query to Skills

Match the user's `query` against:

1. Skill names and slugs (exact match → top priority)
2. Skill descriptions (keyword overlap)
3. Stage labels and descriptions (if user is browsing by stage)
4. Inferred intent (e.g., "SEO" → `seo-audit`, `affiliate-blog-builder`)

If `stage_filter` is provided, restrict results to that stage.

### Step 3: Rank Results

Rank matches by relevance:

1. Direct name/slug match
2. Description keyword match count
3. Stage alignment with user's apparent funnel position

### Step 4: Recommend a Path

If the user's goal spans multiple stages, suggest a skill sequence:

- "You want to go from zero to first commission → S1 → S2 → S3 → S5"
- "You want to optimize existing content → S6 (seo-audit, ab-test-generator)"

### Step 5: Output Results

Present top 3-5 matching skills with:

- Skill name and stage
- What it does (one sentence)
- What input it needs
- Example invocation prompt

### Step 6: Self-Validation

Before presenting output, verify:

- [ ] All matched skills exist in the current registry
- [ ] Example prompts are copy-paste ready and grammatically correct
- [ ] Recommended path follows logical funnel sequence
- [ ] Relevance ranking: exact match > partial match > related
- [ ] Input needed descriptions match actual skill Input Schemas

If any check fails, fix the output before delivering. Do not flag the checklist to the user — just ensure the output passes.

## Output Schema

```yaml
output_schema_version: "1.0.0" # Semver — bump major on breaking changes
matches:
  - skill: string # skill slug
    stage: string # e.g., "S6: Analytics"
    description: string # one-sentence summary
    input_needed: string # what the user needs to provide
    example_prompt: string # copy-paste prompt to invoke the skill
    relevance: string # "exact" | "high" | "related"

recommended_path:
  description: string # why this path
  steps:
    - order: number
      skill: string
      action: string # what this step accomplishes
```

## Output Format

1. **Matching Skills** — table with skill name, stage, description, and relevance
2. **How to Use** — for each top match, show the exact prompt to invoke it
3. **Recommended Path** — if the goal spans multiple stages, a numbered sequence

## Error Handling

- **Empty query**: "What are you trying to accomplish? For example: 'write a blog review', 'track conversions', or 'plan a full funnel'."
- **No matches found**: "No skills match '[query]'. Here are all available stages: [list stages]. Try describing your goal differently."
- **Too broad query ("everything")**: Show one skill per stage as a sampler, then ask: "Which stage interests you most?"

## Examples

### Example 1: Specific task query

**User**: "I want to write a blog review of an AI tool"
**Action**: Match → `affiliate-blog-builder` (S3, exact), `comparison-post-writer` (S3, related), `viral-post-writer` (S2, related). Show top 3 with example prompts. Recommend: "Start with S1 `affiliate-program-search` to find the best program, then use S3 `affiliate-blog-builder` for the review."

### Example 2: Stage browsing

**User**: "What analytics skills are available?"
**Action**: Filter by `analytics` stage → show all 4: `conversion-tracker`, `ab-test-generator`, `performance-report`, `seo-audit`. Describe each with input requirements.

### Example 3: Goal-oriented

**User**: "I'm new to affiliate marketing, where do I start?"
**Action**: Recommend the beginner path: S1 (`affiliate-program-search`) → S2 (`viral-post-writer`) → S3 (`affiliate-blog-builder`) → S5 (`bio-link-deployer`). Explain each step in one sentence.

## References

- `registry.json` — Machine-readable skill catalog. Read in Step 1.
- `shared/references/flywheel-connections.md` — master flywheel connection map

## Revenue & Action Plan

### Expected Outcomes

- **Revenue potential**: The fastest path to your first commission is using the right skill at the right time. Skill Finder saves you hours of guessing — it matches your current situation to the exact workflow that generates revenue. Affiliates who follow a structured skill sequence report 3x faster time-to-first-commission
- **Benchmark**: The typical path to first commission: S1 (find product, 30 min) → S2 (create content, 1 hour) → S5 (distribute, 30 min) = first affiliate link live in 2 hours. First commission typically arrives within 7-14 days
- **Key metric to track**: Time-to-first-commission. How long from "I started" to "I earned my first dollar"? Use `performance-report` to track ongoing revenue

### Do This Right Now (15 min)

1. **Copy the first recommended prompt** from the Recommended Path section and run it immediately
2. **Don't skip steps** — the recommended path is ordered for a reason. S1 before S2, S2 before S5
3. **Set a goal**: earn your first commission within 14 days by running one skill per day
4. **Bookmark this skill** — come back whenever you're unsure what to do next

### Track Your Results

After running 3-5 skills in sequence: do you have a live affiliate link? Is it getting clicks? If yes, you're on the path. If no, re-run Skill Finder with a more specific goal ("I have a blog but no traffic" vs "I'm starting from zero").

> **Next step — run the first skill in your Recommended Path!**

## Flywheel Connections

### Feeds Into

- Any skill — `matched_skill` routes the user to the right skill

### Fed By

- `registry.json` — skill catalog with all 44 skills across 8 stages

### Feedback Loop

- Track which skills are most frequently requested → surface popular skills higher in recommendations

```yaml
chain_metadata:
  skill_slug: "skill-finder"
  stage: "meta"
  timestamp: string
  suggested_next: [] # Dynamic — depends on matched skill
```
