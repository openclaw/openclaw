# Distribution Strategy: affiliate-skills

> 45 skills — largest open-source affiliate marketing AI toolkit.
> Goal: Maximum visibility across all platforms where AI agent skills are discovered.

---

## Master List — All Distribution Channels (Sorted by Impact)

### TIER 1 — Agent Skills Registries (Direct Fit, Auto-Discovery)

| #   | Platform                                                    | How it works                                                                              | Submission                                                                               | Cost | Priority |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- | -------- |
| 1   | **[skills.sh](https://skills.sh)**                          | Vercel's official registry. 83K+ skills, 8M+ installs. Auto-appears via install telemetry | No submission needed. People run `npx skills add Affitor/affiliate-skills` → auto-listed | Free | **P0**   |
| 2   | **[ClawHub.ai](https://clawhub.ai)**                        | OpenClaw registry. 13K+ skills. CLI publish + semantic search                             | `npm i -g clawhub && clawhub login && clawhub sync --all`                                | Free | **P0**   |
| 3   | **[SkillsMP.com](https://skillsmp.com)**                    | Independent marketplace. 350K+ skills. Auto-indexes GitHub repos with SKILL.md            | Automatic GitHub scraping. Ensure proper frontmatter                                     | Free | **P0**   |
| 4   | **[LobeHub Skills](https://lobehub.com/skills)**            | LobeHub platform marketplace (50K+ GitHub stars)                                          | Submit PR to community repo                                                              | Free | **P1**   |
| 5   | **[skild.sh](https://skild.sh)**                            | "npm for Agent Skills" — supports Claude, Codex, Windsurf, Copilot                        | GitHub-compatible: `skild add Affitor/affiliate-skills`                                  | Free | **P1**   |
| 6   | **[skillpm.dev](https://skillpm.dev/registry)**             | npm-based package manager for agent skills                                                | Publish to npm with agent-skills schema                                                  | Free | **P2**   |
| 7   | **[agentskills.so](https://agentskills.so)**                | Skills indexer, auto-discovers from GitHub                                                | Auto-index from repos following agentskills.io standard                                  | Free | **P2**   |
| 8   | **[antfu/skills-npm](https://github.com/antfu/skills-npm)** | npm distribution by Anthony Fu (Vite core)                                                | Publish as npm package                                                                   | Free | **P2**   |

---

### TIER 2 — GitHub Awesome Lists (PR-Based, Permanent SEO)

| #   | List                                                                                                | Stars    | Section Fit                                   | Priority |
| --- | --------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- | -------- |
| 9   | **[punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)**                 | ~81K     | Only if MCP wrapper built                     | P2       |
| 10  | **[VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)**       | ~38K     | "Business/Affiliate" category                 | **P0**   |
| 11  | **[PatrickJS/awesome-cursorrules](https://github.com/PatrickJS/awesome-cursorrules)**               | ~38K     | "Marketing & Business" — has `.cursorrules`   | P1       |
| 12  | **[hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)**         | ~28K     | "Skills" section — canonical list             | **P0**   |
| 13  | **[Hannibal046/Awesome-LLM](https://github.com/Hannibal046/Awesome-LLM)**                           | ~26K     | "LLM Applications & Tools"                    | P1       |
| 14  | **[e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents)**                       | ~20K     | "Specialized Agents"                          | P1       |
| 15  | **[rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit)** | ~15K     | "Skills / Industry-specific"                  | **P0**   |
| 16  | **[steven2358/awesome-generative-ai](https://github.com/steven2358/awesome-generative-ai)**         | ~11K     | "Productivity & Business Tools"               | P1       |
| 17  | **[travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)**             | ~9K      | "Domain Skills" — direct fit                  | **P0**   |
| 18  | **[Shubhamsaboo/awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps)**               | ~88K     | "AI Agents / LLM Tools"                       | P1       |
| 19  | **[VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)**             | ~5K+     | "Business/Affiliate" — direct fit             | **P0**   |
| 20  | **[ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)**         | moderate | Enterprise/developer segment                  | P1       |
| 21  | **[sickn33/antigravity-awesome-skills](https://github.com/sickn33/antigravity-awesome-skills)**     | 1K+      | Community skills contributions                | P1       |
| 22  | **[mahseema/awesome-ai-tools](https://github.com/mahseema/awesome-ai-tools)**                       | ~2K      | Has `marketing.md` — exact fit                | **P0**   |
| 23  | **[heilcheng/awesome-agent-skills](https://github.com/heilcheng/awesome-agent-skills)**             | small    | Claude, Codex, Cursor skills                  | P2       |
| 24  | **[karanb192/awesome-claude-skills](https://github.com/karanb192/awesome-claude-skills)**           | small    | Verified Claude Skills                        | P2       |
| 25  | **[bradAGI/awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)**       | small    | "Agent Skills / Extensions"                   | P2       |
| 26  | **[ichoosetoaccept/awesome-windsurf](https://github.com/ichoosetoaccept/awesome-windsurf)**         | ~500     | Windsurf skills/rules                         | P2       |
| 27  | **[Piebald-AI/awesome-gemini-cli](https://github.com/Piebald-AI/awesome-gemini-cli)**               | ~300     | Gemini CLI skills                             | P2       |
| 28  | **[jmedia65/awesome-ai-marketing](https://github.com/jmedia65/awesome-ai-marketing)**               | small    | "Affiliate Marketing Tools" — niche exact fit | P1       |
| 29  | **[kyrolabs/awesome-agents](https://github.com/kyrolabs/awesome-agents)**                           | ~1.5K    | "Specialized Agent Tools"                     | P2       |

---

### TIER 3 — Launch Platforms (One-Time, High Burst)

| #   | Platform                                                       | Audience                                               | How to Submit                                                          | Cost      | Priority |
| --- | -------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | --------- | -------- |
| 30  | **[Hacker News — Show HN](https://news.ycombinator.com/show)** | ~10M pageviews/day. Front page = 10K–30K visits in 24h | Post "Show HN: 45 Open-Source AI Agent Skills for Affiliate Marketing" | Free      | **P0**   |
| 31  | **[Product Hunt](https://producthunt.com)**                    | ~3M monthly visits. #1 product launch platform         | Schedule launch (Tue–Thu). Gallery, GIF demo, maker comment            | Free      | **P0**   |
| 32  | **[DevHunt](https://devhunt.org)**                             | ~75K monthly. Dev-tool-only. DR 59 backlink            | GitHub PR to MarsX-dev/devhunt                                         | Free      | **P0**   |
| 33  | **[Indie Hackers](https://indiehackers.com)**                  | ~2M monthly. Founders + builders                       | "Show and Tell" post with affiliate marketing angle                    | Free      | P1       |
| 34  | **[BetaList](https://betalist.com)**                           | ~145K monthly. Early adopter newsletter                | Submit form. Free = 2mo wait. $129 = 3-4 days                          | Free/$129 | P2       |

---

### TIER 4 — Developer Writing & Communities

| #   | Platform                                                           | Audience                             | Format                                                                | Priority |
| --- | ------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------- | -------- |
| 35  | **[Dev.to](https://dev.to)** — `#showdev` tag                      | 3M+ monthly devs                     | "I built 45 AI skills for affiliate marketing — here's how"           | **P0**   |
| 36  | **[Reddit r/ClaudeAI](https://reddit.com/r/ClaudeAI)**             | 612K members                         | "I built 45 Claude Code skills for affiliate marketing — open source" | **P0**   |
| 37  | **Reddit r/LocalLLaMA**                                            | 230K+                                | Open source AI tooling angle                                          | P1       |
| 38  | **Reddit r/ArtificialIntelligence**                                | 800K+                                | AI agent skills ecosystem angle                                       | P1       |
| 39  | **Reddit r/SideProject**                                           | 400K+                                | "I built this" format                                                 | P1       |
| 40  | **Reddit r/affiliatemarketing**                                    | 80K                                  | Niche but directly relevant                                           | P1       |
| 41  | **Reddit r/entrepreneur**                                          | 3.5M                                 | Business/affiliate angle                                              | P2       |
| 42  | **[Hashnode](https://hashnode.com)**                               | 1M+ active devs                      | Cross-post Dev.to article                                             | P1       |
| 43  | **[Medium](https://medium.com)** — Towards AI / Better Programming | 500K–3M per publication              | "Building AI Agents for Affiliate Marketing: Open-Source Approach"    | P1       |
| 44  | **[HackerNoon](https://hackernoon.com)**                           | 2M+ monthly readers                  | Technical deep-dive article                                           | P2       |
| 45  | **[Lobste.rs](https://lobste.rs)**                                 | ~50K–100K (invite-only, high signal) | GitHub link or blog post                                              | P2       |

---

### TIER 5 — AI Tool Directories (SEO Backlinks)

| #   | Platform                                                              | Traffic              | Cost          | Priority |
| --- | --------------------------------------------------------------------- | -------------------- | ------------- | -------- |
| 46  | **[There's An AI For That](https://theresanaiforthat.com/submit/)**   | 4–5M monthly         | $347 one-time | P2       |
| 47  | **[Toolify.ai](https://www.toolify.ai/submit)**                       | 5M+ monthly          | Free basic    | **P0**   |
| 48  | **[Futurepedia](https://futurepedia.io)**                             | large + newsletter   | Free basic    | P1       |
| 49  | **[FutureTools.io](https://futuretools.io)**                          | 230K newsletter subs | Free          | P1       |
| 50  | **[AI Agents Directory](https://aiagentsdirectory.com/submit-agent)** | 1,300+ agents listed | Free          | P1       |
| 51  | **[AI Agent Store](https://aiagentstore.ai)**                         | directory            | Free          | P2       |
| 52  | **[AI Agents List](https://aiagentslist.com/submit)**                 | 600+ tools           | Free          | P2       |
| 53  | **[TopAI.tools](https://topai.tools)**                                | 1.2M monthly         | Paid          | P2       |

---

### TIER 6 — Newsletters (Pitch for Coverage)

| #   | Newsletter                                  | Subscribers                 | How to Pitch                                     | Priority |
| --- | ------------------------------------------- | --------------------------- | ------------------------------------------------ | -------- |
| 54  | **[TLDR AI](https://tldr.tech/ai)**         | 1.25M+                      | tips@tldr.tech — or organic via Show HN          | **P0**   |
| 55  | **[The Rundown AI](https://therundown.ai)** | 1.75M+                      | supertools.therundown.ai/submit (free directory) | P1       |
| 56  | **[Superhuman AI](https://superhuman.ai)**  | 1.5M+                       | DM @heykahn on X or passionfroot.me/zain-kahn    | P1       |
| 57  | **[Ben's Bites](https://bensbites.com)**    | 200K+                       | news@bensbites.com                               | P1       |
| 58  | **[Console.dev](https://console.dev)**      | 30–50K (senior devs, CTOs)  | hello@console.dev — merit-based, no pay          | P1       |
| 59  | **[Changelog](https://changelog.com)**      | 100K–500K podcast listeners | news@changelog.com                               | P2       |

---

### TIER 7 — Open Source Discovery

| #   | Platform                                                         | Traffic          | How                                                                           | Priority      |
| --- | ---------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- | ------------- |
| 60  | **GitHub Topics**                                                | millions         | Add topics: `agent-skills`, `claude-code`, `ai-agents`, `affiliate-marketing` | **P0**        |
| 61  | **GitHub Trending**                                              | millions         | Organic — need 50-200+ stars in one day                                       | **P0** (goal) |
| 62  | **[AlternativeTo](https://alternativeto.net/add-new-app/)**      | 5–8M monthly     | List as alternative to Impact.com, ShareASale, Partnerstack                   | P1            |
| 63  | **[OpenAlternative.co](https://openalternative.co/submit)**      | 200–500K monthly | Submit form                                                                   | P1            |
| 64  | **[SourceForge](https://sourceforge.net/p/add_project)**         | 20M monthly      | Create project listing                                                        | P1            |
| 65  | **[LibHunt](https://libhunt.com)**                               | 200K monthly     | Auto-discovers from Reddit/HN/Dev.to mentions                                 | Automatic     |
| 66  | **[OpenSourceAlternative.to](https://opensourcealternative.to)** | 300K monthly     | GitHub PR or form                                                             | P2            |

---

### TIER 8 — Discord Communities

| #   | Server                 | Members | Priority                     |
| --- | ---------------------- | ------- | ---------------------------- |
| 67  | **Anthropic / Claude** | 50K+    | **P0** — #community-projects |
| 68  | **Hugging Face**       | 70K+    | P1 — #showcase               |
| 69  | **OpenAI Developers**  | 100K+   | P1                           |
| 70  | **LangChain**          | 40K+    | P1                           |
| 71  | **Cursor / Windsurf**  | varies  | P2                           |

---

### TIER 9 — MCP Registries (If MCP Wrapper Built)

| #   | Platform                                                              | Size             | How                     | Priority |
| --- | --------------------------------------------------------------------- | ---------------- | ----------------------- | -------- |
| 72  | **[Official MCP Registry](https://registry.modelcontextprotocol.io)** | Anthropic-backed | PR-based                | P2       |
| 73  | **[PulseMCP](https://pulsemcp.com/servers)**                          | 11K+ servers     | Submit button           | P2       |
| 74  | **[mcp.so](https://mcp.so)**                                          | community        | GitHub issue or Submit  | P2       |
| 75  | **[Smithery.ai](https://smithery.ai)**                                | 2K+ servers      | Registry submission     | P2       |
| 76  | **[Glama.ai](https://glama.ai/mcp/servers)**                          | growing          | Submit or auto-discover | P2       |

---

## Execution Plan — 4-Week Launch Sequence

### Week 1: Foundation + Anchor Launch

**Day 1 — Prep:**

- [ ] Fix SKILL.md frontmatter (top-level `version: "1.0.0"`, verify no `<>` in descriptions)
- [ ] Add GitHub topics: `agent-skills`, `claude-code`, `ai-agents`, `affiliate-marketing`, `claude`, `llm`, `open-source`
- [ ] Prepare demo GIF (60-sec skill in action)
- [ ] Prepare one-liner: "45 open-source AI agent skills for affiliate marketing. One install, full funnel."

**Day 2-3 — Coordinated Launch (aim for GitHub Trending):**

- [ ] Show HN post (weekday morning 8-10am ET)
- [ ] Dev.to `#showdev` article (same day)
- [ ] Tweet thread @sonxpiaz (same day)
- [ ] r/ClaudeAI post (same day)
- [ ] r/LocalLLaMA + r/SideProject (same day)

**Day 4-5 — Skills Registries:**

- [ ] Ensure repo is public → skills.sh auto-indexes
- [ ] `clawhub sync --all` for ClawHub
- [ ] SkillsMP auto-discovers
- [ ] Toolify.ai submit

### Week 2: Awesome Lists + Platform Launches

- [ ] PR → awesome-claude-code (hesreallyhim)
- [ ] PR → awesome-claude-skills (travisvn)
- [ ] PR → awesome-agent-skills (VoltAgent)
- [ ] PR → awesome-openclaw-skills (VoltAgent)
- [ ] PR → awesome-ai-tools marketing.md (mahseema)
- [ ] PR → awesome-claude-code-toolkit (rohitg00)
- [ ] Product Hunt launch (Tuesday)
- [ ] DevHunt submission

### Week 3: Newsletters + Directories

- [ ] Pitch TLDR AI (tips@tldr.tech)
- [ ] Submit to The Rundown Supertools
- [ ] Pitch Ben's Bites (news@bensbites.com)
- [ ] Pitch Console.dev (hello@console.dev)
- [ ] Submit Futurepedia, FutureTools.io
- [ ] Submit AI Agents Directory, AI Agents List
- [ ] AlternativeTo listing
- [ ] OpenAlternative.co submission

### Week 4: Long-Tail + Community

- [ ] LinkedIn native post
- [ ] Indie Hackers milestone post
- [ ] Hashnode + Medium cross-posts
- [ ] HackerNoon technical article
- [ ] Anthropic Discord #community-projects
- [ ] Hugging Face Discord #showcase
- [ ] Remaining awesome list PRs (P2 tier)
- [ ] SourceForge listing

---

## Compliance Gaps to Fix Before Launch

| Gap                                 | Impact                          | Fix                                           |
| ----------------------------------- | ------------------------------- | --------------------------------------------- |
| `version` not top-level in SKILL.md | ClawHub publish fails           | Add `version: "1.0.0"` to all 45 frontmatters |
| No `metadata.openclaw` block        | ClawHub discoverability reduced | Add for skills needing env vars               |
| Possible `<>` in descriptions       | skills.sh validation fails      | Audit and remove                              |
| SKILL.md > 500 lines                | skills.sh context efficiency    | Audit and trim if needed                      |
| No `tags` in frontmatter            | ClawHub search reduced          | Add `tags: [affiliate, marketing, ...]`       |
| Missing GitHub topics               | GitHub discovery                | Add via repo settings                         |

---

## Key Metrics to Track

- GitHub stars (daily velocity — need 50-200/day for Trending)
- `npx skills add` install count (skills.sh leaderboard)
- ClawHub download count
- Awesome list PR acceptance rate
- Newsletter mention conversions
- Referral traffic to list.affitor.com
