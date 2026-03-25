# Deep Research Skill

## Description

Perform comprehensive research on any topic using parallel web fetching and intelligent aggregation.

## Capabilities

- Fetch multiple sources in parallel
- Extract and synthesize information
- Generate structured reports
- Handle rate limits and failures gracefully

## Usage

### 1. Define Research Task

```
Topic: <subject>
Depth: shallow | medium | deep
Sources: <list of seed URLs>
Output: <output file path>
```

### 2. Source Types

- **Official docs**: manufacturer/developer sites
- **Wikipedia**: background and overview
- **GitHub**: code examples, implementations
- **ArXiv**: academic papers
- **HuggingFace**: ML models and benchmarks
- **News**: recent developments

### 3. Research Process

1. **Gather sources** - web_fetch seed URLs
2. **Extract key info** - parse relevant sections
3. **Cross-reference** - verify across sources
4. **Synthesize** - combine into coherent report
5. **Format** - structure with headers, tables, code blocks

### 4. Output Format

```markdown
# Research Report: [Topic]

Generated: [Date]

## Executive Summary

[2-3 paragraph overview]

## Key Findings

- Finding 1
- Finding 2
  ...

## Detailed Analysis

### Section 1

[Content]

### Section 2

[Content]

## Recommendations

1. [Recommendation]
2. [Recommendation]

## Sources

- [URL 1]
- [URL 2]
```

## Example

```
Research: "Mac Studio Ultra for AI Development"
Depth: deep
Sources:
  - https://developer.apple.com/machine-learning/
  - https://ml-explore.github.io/mlx/
  - https://huggingface.co/blog/mlx
Output: /workspace/research/mac-ultra-ai.md
```

## Notes

- Use web_fetch, NOT web_search (Brave API not configured)
- Max 10 parallel fetches to avoid rate limits
- Truncate long pages to relevant sections
- Always cite sources
