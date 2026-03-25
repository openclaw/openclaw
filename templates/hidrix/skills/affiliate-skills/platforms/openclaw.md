# Using affiliate-skills with OpenClaw / Custom Agent Frameworks

## Overview

affiliate-skills is framework-agnostic. Any agent framework that accepts system prompts, tool definitions, or HTTP tool specs can load and run these skills. This guide covers integration patterns for OpenClaw, LangChain, AutoGen, CrewAI, and similar orchestration layers.

Key files for framework integration:

| File                                              | Purpose                                               |
| ------------------------------------------------- | ----------------------------------------------------- |
| [`prompts/bootstrap.md`](../prompts/bootstrap.md) | System prompt — paste as agent system instruction     |
| [`API.md`](../API.md)                             | HTTP tool reference for `list.affitor.com/api/v1`     |
| [`registry.json`](../registry.json)               | Skill index — programmatically discover all 45 skills |
| `skills/*/SKILL.md`                               | Per-skill workflow definitions with typed I/O schemas |
| `skills/*/agents/openai.yaml`                     | OpenAI-compatible tool specs (5 skills have these)    |

---

## System Prompt Setup

Load `prompts/bootstrap.md` as your agent's system instruction:

```python
with open("prompts/bootstrap.md") as f:
    content = f.read()
    # Extract everything after the second --- line
    system_prompt = content.split("---", 2)[2]

agent = YourFramework(
    system_prompt=system_prompt,
    model="gpt-4o",  # or any supported model
    tools=[web_search, http_tool]
)
```

The bootstrap prompt is self-contained — it teaches the agent how to search programs, follow skill workflows, chain outputs, and handle FTC compliance.

---

## Tool Definitions

Five skills include OpenAI-compatible tool definitions in `agents/openai.yaml`:

```
skills/research/affiliate-program-search/agents/openai.yaml
skills/content/viral-post-writer/agents/openai.yaml
skills/blog/affiliate-blog-builder/agents/openai.yaml
skills/landing/landing-page-creator/agents/openai.yaml
skills/distribution/bio-link-deployer/agents/openai.yaml
```

For frameworks with different tool spec formats (LangChain `Tool`, CrewAI tools), use these YAML files as the source of truth and translate to your format.

---

## API Integration

All live data skills call `list.affitor.com/api/v1`. Full reference in [`API.md`](../API.md).

```python
# Register an HTTP tool for the Affitor API
affiliate_search = {
    "name": "search_affiliate_programs",
    "description": "Search the Affitor directory for affiliate programs",
    "parameters": {
        "q": {"type": "string", "description": "Search query"},
        "reward_type": {"type": "string", "enum": ["cps_recurring", "cps_one_time", "cps_lifetime", "cpl", "cpc"]},
        "min_cookie_days": {"type": "integer"},
        "sort": {"type": "string", "enum": ["trending", "new", "top"]},
        "limit": {"type": "integer", "default": 10}
    },
    "endpoint": "GET https://list.affitor.com/api/v1/programs"
}
```

No API key required for free tier (max 5 results). Set `AFFITOR_API_KEY` env var for unlimited access.

---

## Skill Discovery via registry.json

Load [`registry.json`](../registry.json) at runtime to dynamically discover skills:

```python
import json

with open("registry.json") as f:
    registry = json.load(f)

# List all skills
for skill in registry["skills"]:
    print(f"[{skill['stage']}] {skill['slug']}: {skill['description'][:80]}")

# Load a specific skill
def load_skill(slug):
    skill = next(s for s in registry["skills"] if s["slug"] == slug)
    with open(f"{skill['path']}/SKILL.md") as f:
        return f.read()

# Use in a multi-agent pipeline
research_instructions = load_skill("affiliate-program-search")
content_instructions = load_skill("viral-post-writer")
```

---

## Multi-Agent Pipeline Example

Chain skills across agents:

```python
# Agent 1: Research
research_agent = Agent(
    instructions=load_skill("affiliate-program-search"),
    tools=[http_tool]
)
program = research_agent.run("Find the best AI video affiliate program")

# Agent 2: Content (pass research output as context)
content_agent = Agent(
    instructions=load_skill("viral-post-writer"),
    context=program.output
)
posts = content_agent.run("Write LinkedIn and Twitter posts about this program")

# Agent 3: Landing Page
landing_agent = Agent(
    instructions=load_skill("landing-page-creator"),
    context=program.output
)
page = landing_agent.run("Create a landing page for this program")
```

---

## Architecture Notes

- **Skills are stateless** — each SKILL.md is a self-contained instruction set
- **Chaining is via context** — pass output of one skill as context to the next
- **I/O schemas** — every SKILL.md defines typed Input/Output schemas for structured data exchange
- **No vendor lock-in** — skills are plain Markdown, API is standard REST
- **Versioning** — `registry.json` includes a `version` field; pin or pull latest from GitHub
