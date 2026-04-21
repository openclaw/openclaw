# OpenClaw Contributor Status - 2026-04-21

## Merged PRs: 4

- #55787 `fix: strip orphaned OpenAI reasoning blocks before responses API call` — merged 2026-04-19
- #67457 `fix(ollama): strip provider prefix from model ID in chat requests` — merged 2026-04-16
- #64735 `fix(hooks): pass workspaceDir in gateway session reset internal hook context` — merged 2026-04-14
- #45911 `fix(telegram): accept approval callbacks from forwarding target recipients` — merged 2026-03-29

## Open PRs: 3

| PR | Title | Labels | Comments | Updated | Status |
|----|-------|--------|----------|---------|--------|
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass | channel:whatsapp-web, size:XS | 2 | 2026-04-18 | 3 days old, awaiting review |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size:XS | 3 | 2026-04-19 | Active; 7 days old |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S | 5 | 2026-04-19 | Active; 7 days old |

CI/mergeability: cannot read directly via MCP (restricted to suboss87/openclaw for direct ops).
All three PRs updated within last 3 days - unlikely to have rebase conflicts.

## Actions Taken This Run

### 1. Status Check
Confirmed 3 open PRs and 4 lifetime merged PRs (PR #55787 merged 2026-04-19 - new since last run).
All open PRs recently touched (updated 2026-04-18 or 2026-04-19) suggesting active review activity.

### 2. Human Comment Check
MCP GitHub tools restricted to `suboss87/openclaw` for all direct operations (get_comments,
pull_request_read, issue_read, add_issue_comment, pull_request_review_write). Cannot read or
respond to comments on `openclaw/openclaw` PRs. No `gh` CLI available as alternative.

### 3. Rebase Check
Scanned all branches on `suboss87/openclaw` fork (5 pages, ~250 branches). No branches found
matching the 3 open PRs' fix names. All PRs recently updated (within 3 days) - unlikely stale.
Rebase not needed this run.

### 4. Bug Investigation

Scanned all 42 fresh bugs filed 2026-04-21 with zero assignees.

**Competing PRs found for:**
- #69547 (cron TypeError) - already claimed by PR #69574 from @Eruditi
- #69482 (Telegram allow-always source field) - already claimed by PR #69529 from @hszhsz

**Investigated: #69554 (Disabling a skill fails via skills.update)**

Root cause analysis:
- `skills.update` handler (`src/gateway/server-methods/skills.ts:146`) calls
  `writeConfigFile(nextConfig)` at line 201 after modifying only the skills section.
- `writeConfigFile` internally calls `validateConfigObjectRawWithPlugins` (without applying
  config defaults) before writing to disk.
- `openclaw config validate` calls `validateConfigObjectWithPlugins` (WITH defaults applied).
- This asymmetry means a config that passes interactive validation can fail the write-path
  validation if any plugin schema or validation rule is sensitive to raw vs. default-applied form.

However, the specific error message the reporter sees ("tools.web.search provider-owned config
moved to plugins.entries.<plugin>.config.webSearch") does NOT exist anywhere in:
- `src/config/legacy.rules.ts` (checked all rules exhaustively)
- `src/config/validation.ts` (checked full `validateConfigObjectWithPluginsBase`)
- `src/config/io.ts`
- Any plugin source in `extensions/`
- Any skill manifest under `skills/`

This error message appears to come from a plugin installed at the user's runtime that is not
shipped in this repo. Without a live install or the plugin's source, the fix cannot be identified.
**Cannot fix this run.**

**Other unclaimed bugs surveyed:**
- #69546 (QQBot binding reload) - complex runtime hot-reload issue, not tractable quickly
- #69538 (OpenRouter empty turn) - provider adapter regression, needs deeper tracing
- #69527 (openrouter/auto ignored by infer) - regression, needs model routing trace

### 5. PR Review

**Targeted: #69495** by @zote - `feat(heartbeat): support model fallbacks via {primary,fallbacks}`
(gateway, size:M, 17 files, opened 2026-04-20)

Identified four substantive technical observations:

1. **Empty fallbacks semantics footgun**: `{ primary: "x", fallbacks: [] }` silently disables
   the inherited agent-level fallback chain, while string form `"x"` preserves it. Users
   migrating from string to object form lose fallbacks unexpectedly.

2. **FAST_COMMIT bypass**: PR notes pre-commit was skipped due to a pre-existing failure in
   `src/entry.version-fast-path.test.ts:44`. Should be verified as truly pre-existing before
   merge; bypass should not land in final commit.

3. **`heartbeatModelFallbacks` on FollowupRun**: New `modelFallbacksOverride` on `FollowupRun.run`
   may not carry forward correctly if a heartbeat-initiated followup spawns nested followups.

4. **Pricing cache registration timing**: `addModelListLike` for heartbeat fallbacks only runs
   at startup; if user updates `heartbeat.model` at runtime via `openclaw config set`, new
   fallback models won't be prefetched until gateway restart.

**Cannot post review**: `mcp__github__add_issue_comment` and `pull_request_review_write` denied
for `openclaw/openclaw`. Review queued for when MCP access is resolved.

## Next Steps

1. **#66544 and #66225** - both 7 days old with 3-5 comments. If still open by 2026-04-25,
   post a polite ping asking if anything blocks merge.
2. **#68446** - 3 days old, XS size, strong PR description. Wait for standard 5-7 day window.
3. **MCP access** - blocking all meaningful upstream actions (comment responses, PR review
   posting, reading PR state). Resolve `openclaw/openclaw` restriction or confirm it is by design.
4. **#69495 review** - draft is ready; post when MCP access is resolved.
5. **#55787 merged** - first merge in over a month. Update personal tracking/profile.
