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
