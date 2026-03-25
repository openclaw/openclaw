#!/bin/bash
set -e

# ============================================================
# Distribution Script for affiliate-skills
# Automates listing on platforms that support CLI/API submission
# ============================================================

REPO="Affitor/affiliate-skills"
REPO_URL="https://github.com/$REPO"
DESCRIPTION="45 open-source AI agent skills for affiliate marketing. Full funnel: research, content, SEO, landing pages, distribution, analytics, automation. Works with Claude Code, ChatGPT, Gemini, Cursor, Windsurf."
SHORT_DESC="Turn any AI into your affiliate marketing team. 45 skills, 8 stages, closed-loop flywheel."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[SKIP]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

# ============================================================
# 1. GitHub Topics (free, instant)
# ============================================================
push_github_topics() {
  echo ""
  echo "=== GitHub Topics ==="

  if ! command -v gh &>/dev/null; then
    fail "gh CLI not installed"
    return
  fi

  TOPICS="agent-skills,claude-code,ai-agents,affiliate-marketing,claude,llm,open-source,ai,marketing,cursor,windsurf,gemini,chatgpt,saas,agentskills"

  gh repo edit "$REPO" --add-topic "${TOPICS//,/ --add-topic }" 2>/dev/null || {
    # Fallback: use API directly
    gh api -X PUT "repos/$REPO/topics" \
      -f "names[]=$( echo $TOPICS | tr ',' '\n' | while read t; do echo -n "\"$t\","; done | sed 's/,$//' )" \
      --silent 2>/dev/null || true

    # Simplest approach
    for topic in $(echo $TOPICS | tr ',' ' '); do
      gh repo edit "$REPO" --add-topic "$topic" 2>/dev/null || true
    done
  }

  log "GitHub topics updated"
}

# ============================================================
# 2. ClawHub publish (requires: npm i -g clawhub)
# ============================================================
push_clawhub() {
  echo ""
  echo "=== ClawHub.ai ==="

  if ! command -v clawhub &>/dev/null; then
    warn "clawhub CLI not installed. Run: npm i -g clawhub && clawhub login"
    echo "  Then run: clawhub sync --all"
    return
  fi

  clawhub sync --all --dry-run
  echo ""
  read -p "Publish all skills to ClawHub? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    clawhub sync --all
    log "Published to ClawHub"
  else
    warn "Skipped ClawHub publish"
  fi
}

# ============================================================
# 3. skills.sh — no action needed, auto-discovers via installs
# ============================================================
check_skillssh() {
  echo ""
  echo "=== skills.sh ==="
  echo "  No submission needed. Auto-appears when users run:"
  echo "    npx skills add $REPO"
  echo ""
  echo "  To check if listed: https://skills.sh/$REPO"
  log "skills.sh — ready (install-driven)"
}

# ============================================================
# 4. npm publish (for skillpm.dev + antfu/skills-npm)
# ============================================================
push_npm() {
  echo ""
  echo "=== npm (skillpm.dev / skills-npm) ==="

  if ! command -v npm &>/dev/null; then
    fail "npm not found"
    return
  fi

  # Check if logged in
  if ! npm whoami &>/dev/null; then
    warn "Not logged in to npm. Run: npm login"
    return
  fi

  echo "  Would publish as: affiliate-skills@1.0.0"
  read -p "Publish to npm? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm publish --access public
    log "Published to npm"
  else
    warn "Skipped npm publish"
  fi
}

# ============================================================
# 5. Generate awesome list PR descriptions
# ============================================================
generate_pr_templates() {
  echo ""
  echo "=== Awesome List PR Templates ==="

  TEMPLATE_DIR="$(dirname "$0")/../docs/pr-templates"
  mkdir -p "$TEMPLATE_DIR"

  # Common PR body
  PR_BODY="## Add affiliate-skills

**Repository:** $REPO_URL
**License:** MIT
**Skills:** 45
**Standard:** [agentskills.io](https://agentskills.io)

### What it is

$DESCRIPTION

### Compatibility

Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent.

### Install

\`\`\`bash
npx skills add $REPO
\`\`\`

### Why include it

- Largest open-source affiliate marketing skill collection (45 skills)
- Follows agentskills.io standard
- Full funnel coverage (8 stages with closed-loop flywheel)
- Works across all major AI coding agents
- Active development, MIT licensed"

  echo "$PR_BODY" > "$TEMPLATE_DIR/awesome-list-pr-body.md"

  # Individual list entries
  cat > "$TEMPLATE_DIR/list-entries.md" << 'ENTRIES'
# Copy-paste entries for each awesome list

## awesome-claude-code / awesome-claude-skills
- [affiliate-skills](https://github.com/Affitor/affiliate-skills) - 45 AI-powered affiliate marketing skills covering the full funnel: research, content, SEO, landing pages, distribution, analytics, automation. Works with Claude Code and 6+ other AI agents.

## awesome-agent-skills / awesome-openclaw-skills
- [affiliate-skills](https://github.com/Affitor/affiliate-skills) - 45 open-source skills for affiliate marketing. Full 8-stage flywheel with skill chaining. Follows agentskills.io standard. `npx skills add Affitor/affiliate-skills`

## awesome-ai-agents
- [affiliate-skills](https://github.com/Affitor/affiliate-skills) - Open-source AI agent skill set for affiliate marketing. 45 skills across 8 stages with closed-loop optimization. Compatible with Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf.

## awesome-ai-tools (marketing.md)
- [affiliate-skills](https://github.com/Affitor/affiliate-skills) - 45 AI-powered skills that turn any AI into an affiliate marketing team. Research programs, write content, build landing pages, deploy, track, optimize. Open source, MIT licensed.

## awesome-generative-ai
- [affiliate-skills](https://github.com/Affitor/affiliate-skills) - 45 generative AI skills for affiliate marketing covering research, content creation, SEO, landing pages, distribution, analytics, and automation. Open source.

## awesome-ai-marketing
- [affiliate-skills](https://github.com/Affitor/affiliate-skills) - The most comprehensive open-source AI toolkit for affiliate marketing. 45 skills across 8 stages with a closed-loop flywheel. Works with any AI agent.
ENTRIES

  log "PR templates saved to docs/pr-templates/"
}

# ============================================================
# 6. Generate social media post drafts
# ============================================================
generate_social_drafts() {
  echo ""
  echo "=== Social Media Drafts ==="

  DRAFT_DIR="$(dirname "$0")/../docs/launch-content"
  mkdir -p "$DRAFT_DIR"

  # Show HN
  cat > "$DRAFT_DIR/show-hn.md" << 'EOF'
# Show HN Post

**Title:** Show HN: 45 open-source AI agent skills for affiliate marketing

**Text:**
I built an open-source collection of 45 AI agent skills that cover the full affiliate marketing funnel — from program research to content creation, SEO, landing pages, deployment, analytics, and automation.

Each skill is a SKILL.md file (following the agentskills.io standard) that works with Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, and any AI that reads text.

The idea: instead of using AI as a chatbot, give it structured knowledge about affiliate marketing workflows. Each skill has input/output schemas so they can chain together — S1 Research finds programs, S2 Content writes posts, S3 Blog builds SEO content, and S6 Analytics feeds back into S1 for optimization.

Install: `npx skills add Affitor/affiliate-skills`

GitHub: https://github.com/Affitor/affiliate-skills

Technical details:
- 45 skills across 8 stages
- Closed-loop flywheel (analytics feeds back to research)
- MIT licensed
- Each skill works standalone or chains with others
- Built-in FTC compliance checking
- Data from list.affitor.com (community affiliate directory)

Happy to answer questions about the architecture or the agentskills.io standard.
EOF

  # Dev.to
  cat > "$DRAFT_DIR/devto-article.md" << 'EOF'
---
title: "I Built 45 AI Agent Skills for Affiliate Marketing — Here's How They Work"
published: false
description: "Open-source skill collection that turns any AI into an affiliate marketing team. Full funnel coverage with a closed-loop flywheel."
tags: showdev, ai, opensource, affiliate
cover_image:
---

## The Problem

AI is great at writing copy. But ask it to "find the best affiliate program for AI video tools" and you get generic, outdated advice from its training data.

What if your AI could query a real-time database, compare commission rates, calculate potential earnings, then write optimized content — all in one conversation?

## What I Built

[affiliate-skills](https://github.com/Affitor/affiliate-skills) — 45 open-source AI agent skills that cover the entire affiliate marketing funnel:

| Stage | Skills | What they do |
|-------|--------|-------------|
| S1 Research | 6 | Find and evaluate affiliate programs |
| S2 Content | 5 | Write viral social media posts |
| S3 Blog & SEO | 7 | Build optimized blog content |
| S4 Landing Pages | 8 | Create high-converting HTML pages |
| S5 Distribution | 4 | Deploy and schedule content |
| S6 Analytics | 5 | Track performance and optimize |
| S7 Automation | 5 | Scale what works |
| S8 Meta | 5 | Plan, audit, improve the system |

### The Flywheel

The key insight: skills chain together. S6 Analytics feeds data back to S1 Research, creating a closed optimization loop. Each skill has typed input/output schemas for agent interop.

### How It Works

Each skill is a `SKILL.md` file following the [agentskills.io](https://agentskills.io) open standard. The AI reads the file and gains structured knowledge about a specific workflow.

```bash
# Install (Claude Code)
npx skills add Affitor/affiliate-skills

# Or paste the bootstrap prompt into any AI
```

### Try It

Paste this into any AI:

```
Search the Affitor affiliate directory for AI video tools.
Use this API: GET https://list.affitor.com/api/v1/programs?q=AI+video&sort=top&limit=5
Show me the results in a table with: Name, Commission, Cookie Duration, Stars.
Then recommend the best one and explain why.
```

## Architecture

- **Standard:** agentskills.io (Anthropic, Linux Foundation AAIF)
- **Compatibility:** Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw
- **Data source:** list.affitor.com REST API
- **License:** MIT

## Links

- GitHub: https://github.com/Affitor/affiliate-skills
- Install: `npx skills add Affitor/affiliate-skills`
- Directory: https://list.affitor.com

---

What skills would you add? I'm looking for contributors to expand the collection.
EOF

  # Twitter/X thread
  cat > "$DRAFT_DIR/twitter-thread.md" << 'EOF'
# Twitter/X Thread

1/ I just open-sourced 45 AI agent skills for affiliate marketing.

One install. Full funnel. Works with Claude Code, ChatGPT, Gemini, Cursor, Windsurf.

npx skills add Affitor/affiliate-skills

🧵 Here's what it does ↓

2/ The problem: AI is great at writing copy, but terrible at affiliate marketing workflows.

It doesn't know commission rates, can't compare programs, and gives generic advice from training data.

3/ The fix: structured skills that teach AI *how* to do affiliate marketing, not just what it is.

45 skills across 8 stages:
• Research & Discovery (6)
• Content Creation (5)
• Blog & SEO (7)
• Landing Pages (8)
• Distribution (4)
• Analytics (5)
• Automation (5)
• Meta (5)

4/ The key: skills chain together in a closed-loop flywheel.

S1 Research → S2 Content → S3 Blog → S4 Landing Page → S5 Deploy → S6 Analytics → back to S1

Analytics data feeds back to improve research. The system gets smarter.

5/ Each skill follows the agentskills.io open standard.

That means it works everywhere:
• Claude Code ✅
• ChatGPT ✅
• Gemini CLI ✅
• Cursor ✅
• Windsurf ✅
• OpenClaw ✅
• Any AI that reads text ✅

6/ Try it right now — no install needed.

Paste this into any AI:

"Search the Affitor directory for AI video tools. Use API: GET https://list.affitor.com/api/v1/programs?q=AI+video&sort=top&limit=5"

7/ MIT licensed. Open source. Looking for contributors.

GitHub: https://github.com/Affitor/affiliate-skills

If you do affiliate marketing with AI, this saves you hours per week.

Star it, fork it, build on it. ⭐
EOF

  # LinkedIn post
  cat > "$DRAFT_DIR/linkedin-post.md" << 'EOF'
# LinkedIn Post

I just open-sourced the largest collection of AI agent skills for affiliate marketing.

45 skills. 8 stages. One install.

Here's the thing most people miss about AI + affiliate marketing:

The AI isn't the bottleneck. The workflow is.

You can ask ChatGPT to "write a product review" and get decent copy.

But can it:
→ Query a real-time database of affiliate programs?
→ Compare commission structures across competitors?
→ Build a landing page optimized for conversion?
→ Set up an email drip sequence?
→ Track which content actually drives clicks?

That's what affiliate-skills does.

Each skill is a structured instruction file that teaches AI a specific affiliate marketing workflow. They chain together in a closed-loop flywheel — analytics feeds back into research, so the system optimizes itself.

Works with Claude Code, ChatGPT, Gemini, Cursor, Windsurf, and any AI agent.

MIT licensed. Free forever.

Install: npx skills add Affitor/affiliate-skills
GitHub: https://github.com/Affitor/affiliate-skills

What would you add to it?

#OpenSource #AffiliateMarketing #AI #AIAgents #BuildInPublic
EOF

  # Reddit r/ClaudeAI
  cat > "$DRAFT_DIR/reddit-claudeai.md" << 'EOF'
# Reddit r/ClaudeAI Post

**Title:** I built 45 Claude Code skills for affiliate marketing (open source)

**Body:**

I've been building a collection of AI agent skills focused on affiliate marketing. Just hit 45 skills across 8 stages — research, content, blog/SEO, landing pages, distribution, analytics, automation, and meta.

**Install:**
```
npx skills add Affitor/affiliate-skills
```

**What it does:**

Each skill teaches Claude Code a specific affiliate marketing workflow. They follow the agentskills.io standard and chain together — the output of one skill feeds into the next.

Example flow:
1. `/affiliate-program-search` — finds programs from a real-time database
2. `/viral-post-writer` — writes social content for the program
3. `/landing-page-creator` — builds a conversion-optimized HTML page
4. `/conversion-tracker` — sets up tracking
5. `/performance-report` — analyzes what's working

The analytics feed back into research, creating a closed optimization loop.

**Key features:**
- 45 skills with typed I/O schemas
- Real-time data from list.affitor.com API
- Built-in FTC compliance checking
- Works standalone or chained
- MIT licensed

Also works with ChatGPT, Gemini CLI, Cursor, Windsurf — any AI that reads text.

GitHub: https://github.com/Affitor/affiliate-skills

Looking for feedback and contributors. What skills would be most useful to add?
EOF

  log "Launch content saved to docs/launch-content/"
}

# ============================================================
# 7. Directory submission URLs (manual)
# ============================================================
print_manual_submissions() {
  echo ""
  echo "=== Manual Submissions (open these URLs) ==="
  echo ""
  echo "AI Directories:"
  echo "  1. https://www.toolify.ai/submit — Toolify (free, 5M monthly)"
  echo "  2. https://futurepedia.io — Futurepedia (free)"
  echo "  3. https://futuretools.io — FutureTools (free)"
  echo "  4. https://aiagentsdirectory.com/submit-agent — AI Agents Directory (free)"
  echo "  5. https://aiagentslist.com/submit — AI Agents List (free)"
  echo "  6. https://supertools.therundown.ai/submit — Rundown Supertools (free)"
  echo ""
  echo "Open Source:"
  echo "  7. https://openalternative.co/submit — OpenAlternative (free)"
  echo "  8. https://alternativeto.net/add-new-app/ — AlternativeTo (free)"
  echo "  9. https://sourceforge.net/p/add_project — SourceForge (free)"
  echo ""
  echo "Launch:"
  echo "  10. https://producthunt.com/posts/new — Product Hunt (free)"
  echo "  11. https://devhunt.org — DevHunt via GitHub PR (free)"
  echo ""
  echo "Newsletters (email pitch):"
  echo "  12. tips@tldr.tech — TLDR AI (1.25M subs)"
  echo "  13. hello@console.dev — Console.dev (merit-based)"
  echo "  14. news@changelog.com — Changelog"
  echo "  15. news@bensbites.com — Ben's Bites"
  echo ""
}

# ============================================================
# Main
# ============================================================
echo "============================================"
echo "  affiliate-skills Distribution Pipeline"
echo "  Repo: $REPO"
echo "============================================"

case "${1:-all}" in
  topics)    push_github_topics ;;
  clawhub)   push_clawhub ;;
  skillssh)  check_skillssh ;;
  npm)       push_npm ;;
  templates) generate_pr_templates ;;
  social)    generate_social_drafts ;;
  manual)    print_manual_submissions ;;
  all)
    push_github_topics
    check_skillssh
    push_clawhub
    push_npm
    generate_pr_templates
    generate_social_drafts
    print_manual_submissions
    echo ""
    echo "============================================"
    echo "  Distribution pipeline complete!"
    echo "============================================"
    ;;
  *)
    echo "Usage: $0 [topics|clawhub|skillssh|npm|templates|social|manual|all]"
    ;;
esac
