# midday check - 2026-04-24

## open PRs (suboss87 -> openclaw/openclaw)

| # | title | created | status |
|---|-------|---------|--------|
| #3 | fix(configure): preserve custom primary model when reconfiguring auth | 2026-04-24 | open, no feedback |
| #2 | fix(discord): handle partial GuildThreadChannel in thread slash command parentId access | 2026-04-23 | open, no feedback |
| #1 | fix(gateway): clean up MCP child processes after nested lane runs end | 2026-04-23 | open, no feedback |

## actions this run

- git identity confirmed: suboss87@gmail.com
- checked all 3 open PRs - no issue comments, no review threads from humans or bots
- upstream sync skipped: proxy blocks access to openclaw/openclaw git remote (HTTP 502)
- bug hunt skipped: gh CLI not installed, MCP tools restricted to fork only, upstream git unreachable - no path to search openclaw/openclaw issues this run

## escalations

- tooling gap: can't reach upstream (openclaw/openclaw) via git, gh, or MCP. only fork is accessible. bug hunt and upstream sync are blocked until proxy config is updated to allow openclaw/openclaw.
