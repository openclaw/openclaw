# OpenClaw Contributor Status - 2026-04-20

## Merged PRs: 3

- #67457 `fix(ollama): strip provider prefix from model ID in chat requests` — merged 2026-04-16
- #64735 `fix(hooks): pass workspaceDir in gateway session reset internal hook context` — merged 2026-04-14
- #45911 `fix(telegram): accept approval callbacks from forwarding target recipients` — merged 2026-03-29

No new merges confirmed since last run (2026-04-18). PRs #66544, #66225, and #68446 are
still open and receiving comment/reaction activity.

## Open PRs: 3

| PR | Title | Labels | Comments | Updated | Status |
|----|-------|--------|----------|---------|--------|
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass | channel:whatsapp-web, size:XS | 2 | 2026-04-18 | Fresh (2 days old), awaiting review |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size:XS | 3 | 2026-04-19 | Active comment activity, +1 reaction |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S | 5 | 2026-04-19 | Active comment activity, +1 reaction |

Note: #56978 was superseded by #68446 (same bug, updated code path). #55787 dropped from
tracking — no longer visible in open PRs search.

**CI/mergeability:** Cannot read directly via MCP tools (restricted to suboss87/openclaw).

## Actions Taken This Run

### 1. Status Check
Confirmed 3 open PRs and 3 lifetime merged PRs. No new merges since #67457 on 2026-04-16.
Both #66544 and #66225 had updated timestamps of 2026-04-19, suggesting continued review
activity. #68446 opened 2026-04-18 with 2 comments and a +1 reaction — early traction.

### 2. Human Comment Check
MCP GitHub tools restricted to `suboss87/openclaw`; all reads and writes to
`openclaw/openclaw` (issue/PR comments, review comments) are blocked. Cannot respond to
human comments this run. No `gh` CLI available as alternative.

### 3. Rebase Check
No PR branches present in the local fork worktree (only `main`). PR branches live in the
upstream fork and cannot be checked for divergence without access to `openclaw/openclaw`
refs. Skipped this run.

### 4. Bug Investigation

Scanned fresh bugs filed 2026-04-19/20 with zero assignees and regression/behavior labels.

**Investigated: #69160 (Onboarding multiple providers overwrites agents.defaults.models)**
Full issue body confirmed. Reproduction: QuickStart → Custom Provider → save → re-run
onboard → "Use existing values" → add Google Gemini CLI via OAuth. Second provider replaces
`agents.defaults.models` entirely.

Traced the Gemini CLI path:
`auth-choice.apply.google-gemini-cli.ts` → `applyAuthChoicePluginProvider` →
`runProviderPluginAuthMethod` (`auth-choice.apply.plugin-provider.ts:59`).

At line 75-76, the plugin's result is applied:
```typescript
if (result.configPatch) {
  nextConfig = mergeConfigPatch(nextConfig, result.configPatch);
}
```
`mergeConfigPatch` (`src/commands/provider-auth-helpers.ts:44`) is a correct deep merge for
plain objects — verified it preserves existing model keys when the patch only adds new ones.
The bug is NOT in `mergeConfigPatch`.

Likely root cause: the `google-gemini-cli-auth` extension plugin returns a `configPatch`
where `agents.defaults.models` is a non-plain-object value (string, number, or array),
bypassing the recursive merge and assigning directly. The extension source is not in the
local fork. **Cannot fix this run.**

**Investigated: #69158 (spawn ENAMETOOLONG on Windows with claude-cli)**
Root cause confirmed in code. `DEFAULT_CLAUDE_BACKEND` (`src/agents/cli-backends.ts:40`)
sets `input: "arg"` and `systemPromptArg: "--append-system-prompt"`. The system prompt is
injected as a CLI arg at `src/agents/cli-runner/helpers.ts:363`:
```typescript
args.push(params.backend.systemPromptArg, params.systemPrompt);
```
On Windows, `claude` is installed as `claude.cmd`. Node.js spawns `.cmd` files via cmd.exe,
which has an 8191-char command-line limit. The system prompt (bootstrap files + OpenClaw
base prompt) easily exceeds this. The existing `maxPromptArgChars` guard in
`resolvePromptInput` only protects the user prompt, not the system prompt.

Fix would require a `systemPromptMaxArgChars` threshold that falls back to stdin embedding
(or a `--system-prompt-file` flag if claude CLI supports it). Nontrivial to implement
safely without testing on Windows. **Cannot fix this run.**

**Investigated: #69132 (Ollama web_search fails with 404 on Ollama 0.16.0)**
The constant `OLLAMA_WEB_SEARCH_PATH = "/api/experimental/web_search"` appears in the
bundled dist but has no match in `src/` or `extensions/ollama/`. This belongs to the
external `@ollama/openclaw-web-search` npm package. **Out of scope for this repo.**

### 5. PR Review

Identified PR #69177 by @skylee-01 (`fix(agents): pass contextTokens to buildStatusText in
session_status tool`, agents/XS) as the strongest review candidate — fresh today, agents
lane, clear bug description.

Cannot post review: `mcp__github__pull_request_read` on `openclaw/openclaw` is access-denied.
Technical notes for when access is restored:
- The fix adds `contextTokens: resolved.entry?.contextTokens` to the `buildStatusText()`
  call in `session-status-tool.ts`. Worth checking that `resolved.entry?.contextTokens` is
  populated before this path — if the session entry doesn't carry `contextTokens` (e.g., for
  very new sessions), the fix may still show 0.
- Confirm `buildStatusText`'s signature actually accepts `contextTokens` as a named param,
  distinct from `buildStatusMessage` which resolves tokens internally.

## Next Steps

1. **#66544 and #66225** — both 6 days old with 3-5 comments and reactions. If still open
   by 2026-04-24, consider a gentle follow-up asking if anything blocks merge.
2. **#68446** — 2 days old, XS size. Give it the standard review window (5-7 days).
3. **#69160 fix** — worth targeting once the `extensions/google-gemini-cli-auth` source
   is accessible. Confirmed code path; fix is likely a one-liner in the plugin's
   `configPatch` construction.
4. **MCP access** — blocking all meaningful upstream actions. Confirm whether the
   `openclaw/openclaw` restriction is intentional or a configuration gap.
5. **Windows ENAMETOOLONG (#69158)** — 100% repro, affects all Windows claude-cli users.
   High priority for next code contribution.
