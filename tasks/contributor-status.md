# OpenClaw Contributor Status - 2026-04-25

## Merged PRs: 5 (lifetime, gap to 46: 41)

- 2026-04-23: #70413 fix(agents): route /btw through provider stream fn for correct URLs
- 2026-04-19: #55787 fix: strip orphaned OpenAI reasoning blocks before responses API call
- 2026-04-16: #67457 fix(ollama): strip provider prefix from model ID in chat requests
- 2026-04-14: #64735 fix(hooks): pass workspaceDir in gateway session reset internal hook context
- 2026-03-29: #45911 fix(telegram): accept approval callbacks from forwarding target recipients

## Open PRs: 6

| #      | Title                                                                          | Labels                | Age | Status          |
| ------ | ------------------------------------------------------------------------------ | --------------------- | --- | --------------- |
| #4     | fix: check exit code in openUrl to avoid false positive on Windows             | —                     | <1d | Awaiting review |
| #70413 | fix(agents): route /btw through provider stream fn for correct URLs            | agents, size:S        | 2d  | Awaiting review |
| #69685 | fix(agents): strip final tags from persisted assistant message                 | agents, size:S        | 3d  | Awaiting review |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass      | whatsapp-web, size:XS | 6d  | Awaiting review |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name            | gateway, size:XS      | 10d | Awaiting review |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S        | 10d | Awaiting review |

## Actions Taken This Run (2026-04-25)

### New fix: openUrl false positive on Windows (closes #71098)

**Issue**: `dashboard` logs "Opened in your browser" on Windows even when no browser launched.

**Root cause**: `openUrl()` in `src/commands/onboard-helpers.ts` called
`runCommandWithTimeout(...)` and discarded the result, returning `true` unconditionally as
long as spawn did not throw. Because `cmd /c start` can exit non-zero (unregistered URL
scheme, no default browser configured), ignoring the exit code produces a silent false
positive.

**Fix**: Capture the `SpawnResult` and return `result.code === 0` instead of bare `true`.
Added a regression test: `openUrl` returns `false` on win32 when the spawned command exits
with a non-zero code. All 14 tests pass.

**Branch pushed**: `suboss87:fix/windows-openurl-exit-code`

**Fork PR**: https://github.com/suboss87/openclaw/pull/4

**Competition check**: PR #69584 and its splits (#70474, #70477) target OAuth browser-open
fallback and TUI hatch terminal restore / bootstrap auth. None address the `dashboard`
command's Windows exit-code false positive. PR #4 is uncontested.

### Comment / rebase check

MCP GitHub tools restricted to `suboss87/openclaw`. Cannot read PR-level comments on
`openclaw/openclaw`. No rebase check possible without upstream remote access.

## Pending upstream PR opens (carried forward)

- `fix/browser-snapshot-pw-aria-snapshot-public-api` (closes #70158, #70337)
- `fix/mcp-nested-run-cleanup` (closes #70364)
- `fix/configure-preserves-custom-primary-model` (closes #70696)

## Next Steps

1. Open upstream PRs for the three pending branches above.
2. Follow up on #66544 and #66225 (10 days old, may need a ping).
3. Check comment activity on #69685 and #68446.
