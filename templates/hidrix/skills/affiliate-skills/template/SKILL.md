---
name: your-skill-name
description: >
  Replace with when the AI should activate this skill. Be pushy — cover multiple
  phrasings so the AI activates for a wide range of user prompts.
license: MIT
version: "1.0.0"
tags: ["affiliate-marketing"]
compatibility: "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent"
metadata:
  author: your-github-handle
  version: "1.0"
  stage: SX-StageName
---

# Your Skill Name

What this skill does in 2-3 sentences. Focus on the outcome, not the process.

## Stage

This skill belongs to Stage SX: StageName

## When to Use

- Scenario 1
- Scenario 2
- Scenario 3

## Input Schema

```
{
  required_field: {          # (required) Description
    name: string             # Example value
  }
  optional_field: string     # (optional, default: "value") Description
}
```

## Workflow

### Step 1: Gather Context

What to check first. How to handle missing inputs.

### Step 2: Execute Core Task

The main work the skill does.

### Step 3: Format and Deliver

How to structure the output.

## Output Schema

Other skills can consume these fields from conversation context:

```
{
  primary_output: string     # Main result for downstream chaining
  secondary_output: string   # Additional data for downstream skills
}
```

## Output Format

```
## [Skill Name]: [Context]

### Section 1
[Main content]

### Section 2
[Supporting content]
```

## Error Handling

- **Missing required input:** How to recover gracefully.
- **External data unavailable:** Fallback strategy.
- **Edge case:** How to handle unexpected scenarios.

## Examples

**Example 1:** [realistic user prompt]
→ [step-by-step what the skill does]
→ [expected output summary]

**Example 2:** [different scenario]
→ [step-by-step]
→ [expected output summary]

**Example 3:** [edge case or beginner scenario]
→ [step-by-step]
→ [expected output summary]

## Flywheel Connections

### Feeds Into

- `[skill]` (S[X]) — [what data/output flows forward to this skill]

### Fed By

- `[skill]` (S[X]) — [what data/output flows back from this skill]

### Feedback Loop

- [analytics metric or data point that improves this skill's next run]

## Quality Gate

> Include this section for content-producing skills (S2, S3, S4, S5, S7). Remove for non-content skills.

Before delivering output, verify:

1. Would I share this on MY personal social?
2. Contains specific, surprising detail? (not generic)
3. Respects reader's intelligence?
4. Remarkable enough to share? (Purple Cow test)
5. Irresistible offer framing? (if S4 offer skills ran)

Any NO → rewrite before delivering. Do not flag this checklist to the user.

## Volume Mode

> Include this section for S2 Content skills only. Remove for other stages.

When `mode: "volume"`:

- Generate 5-10 variations instead of 1
- Prioritize speed + variety over perfection
- Tag each with variant ID for A/B tracking
- Let data pick the winner (GaryVee philosophy)

```yaml
volume_output:
  variants:
    - id: string # e.g., "v1", "v2"
      content: string # The variation
      angle: string # What makes this one different
```

## References

- `references/your-reference.md` — description of what it contains
- `shared/references/ftc-compliance.md` — FTC disclosure requirements
- `shared/references/affitor-branding.md` — branding rules
- `shared/references/flywheel-connections.md` — master flywheel connection map
