# OpenClaw Contributor Status - 2026-04-24

## Merged PRs: 5 (lifetime, gap to 46: 41)

- 2026-04-23: #70413 fix(agents): route /btw through provider stream fn for correct URLs
- 2026-04-19: #55787 fix: strip orphaned OpenAI reasoning blocks before responses API call
- 2026-04-16: #67457 fix(ollama): strip provider prefix from model ID in chat requests
- 2026-04-14: #64735 fix(hooks): pass workspaceDir in gateway session reset internal hook context
- 2026-03-29: #45911 fix(telegram): accept approval callbacks from forwarding target recipients

## Open PRs: 5

| #      | Title                                                                          | Labels                | Age | Status          |
| ------ | ------------------------------------------------------------------------------ | --------------------- | --- | --------------- |
| #70413 | fix(agents): route /btw through provider stream fn for correct URLs            | agents, size:S        | <1d | Awaiting review |
| #69685 | fix(agents): strip final tags from persisted assistant message                 | agents, size:S        | 2d  | Awaiting review |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass      | whatsapp-web, size:XS | 5d  | Awaiting review |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name            | gateway, size:XS      | 9d  | Awaiting review |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S        | 9d  | Awaiting review |

## Actions Taken This Run (2026-04-24)

### New fix: browser snapshot Playwright compat (closes #70158, #70337)

**Issue**: `refs=aria` and the AI snapshot path both throw immediately on playwright-core
1.59.1+ because `page._snapshotForAI` was removed. Error messages seen in the wild:

- `refs=aria requires Playwright _snapshotForAI support.`
- `Playwright _snapshotForAI is not available. Upgrade playwright-core.`

**Root cause confirmed**: `src/browser/pw-tools-core.snapshot.ts` line 66
(`snapshotAiViaPlaywright`) and line 120 (`snapshotRoleViaPlaywright` refs=aria path) both
hard-fail when `_snapshotForAI` is absent. The public replacement
`locator.ariaSnapshot({ mode: 'ai' })` has been available since Playwright 1.52.

**Fix**: Added `LocatorWithAriaAiMode` type and dual-path logic in both call sites. Prefers
`_snapshotForAI` when present (backward compat), falls through to the public API otherwise.

**Tests**: 5 new regression tests in
`src/browser/pw-tools-core.snapshot.playwright-compat.test.ts`, all pass.

**Branch pushed**: `suboss87:fix/browser-snapshot-pw-aria-snapshot-public-api`

**PR to open manually**:
https://github.com/openclaw/openclaw/compare/main...suboss87:fix/browser-snapshot-pw-aria-snapshot-public-api

Closes #70158 and #70337.

### New fix: MCP child process leak in nested gateway runs (closes #70364)

**Issue**: Every `sessions_send` to another agent leaks a full cohort of MCP child processes.
With 9 agents configured, each `sessions_send` adds 9 new children that are never cleaned up.

**Root cause**: `cleanupBundleMcpOnRunEnd` was only set to `true` in the CLI `--local` path.
When `sessions_send` dispatches via `dispatchAgentRunFromGateway`, the `ingressOpts` had no
`cleanupBundleMcpOnRunEnd`, so `retireSessionMcpRuntime` never fired for gateway-path nested
sessions.

**Fix**: Added `cleanupBundleMcpOnRunEnd: isNestedAgentLane(request.lane)` to `ingressOpts`
in `src/gateway/server-methods/agent.ts`. Nested lane runs tear down their MCP cohort on
completion; top-level gateway sessions keep processes warm across turns.

**Branch pushed**: `suboss87:fix/mcp-nested-run-cleanup` (commit c6f7614c)
All pre-commit gates passed: typecheck, lint, 474 tests.

**PR to open manually**:
https://github.com/suboss87/openclaw/compare/fix/mcp-nested-run-cleanup

### Comment / rebase check

Unable to read PR-level comments on `openclaw/openclaw` (GitHub MCP restricted to fork).
No changes-requested reviews found via search API. No rebases attempted.

### New fix this run: configure wizard clobbers primary model (closes #70696)

Root cause in `src/commands/auth-choice.default-model.ts`: `applyDefaultModelChoice`
with `setDefaultModel: true` called `applyDefaultConfig` unconditionally, which always
calls `applyAgentDefaultModelPrimary` overwriting the user's custom primary model.

Fix: if an existing primary is set, use `applyProviderConfig` (sets up auth/allowlist
only, does not touch primary). 12-line change + 4 unit tests, all pass, lint clean.

Branch `fix/configure-preserves-custom-primary-model` pushed to fork.
Upstream PR to open manually:
https://github.com/openclaw/openclaw/compare/main...suboss87:openclaw:fix/configure-preserves-custom-primary-model

## Next Steps

1. Open upstream PRs for all three pending branches (browser-snapshot, mcp-nested-run-cleanup, configure-preserves-custom-primary-model).
2. Follow up on #66544 and #66225 (10 days old, may need a ping).
3. Check comment activity on #69685 and #68446.
