# OpenClaw Contributor Status - 2026-04-22

## Merged PRs: 4 (lifetime)

- 2026-04-19: #55787 fix: strip orphaned OpenAI reasoning blocks before responses API call
- 2026-04-16: #67457 fix(ollama): strip provider prefix from model ID in chat requests
- 2026-04-14: #64735 fix(hooks): pass workspaceDir in gateway session reset internal hook context
- 2026-03-29: #45911 fix(telegram): accept approval callbacks from forwarding target recipients

## Open PRs: 4

| #      | Title                                                                          | Labels                | Age | Comments | Status          |
| ------ | ------------------------------------------------------------------------------ | --------------------- | --- | -------- | --------------- |
| #69685 | fix(agents): strip final tags from persisted assistant message                 | agents, size:M        | 1d  | 2        | Awaiting review |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass      | whatsapp-web, size:XS | 4d  | 2        | Awaiting review |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name            | gateway, size:XS      | 8d  | 3        | Awaiting review |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S        | 8d  | 5        | Awaiting review |

CI and mergeable status not available (GitHub MCP restricted to fork; search API does not surface per-PR check status).

## Actions Taken This Run

### Bug Fix filed: #69960 (plugins install --profile X writes to wrong extensions dir)

**Root cause confirmed in code:**

`CONFIG_DIR` in `src/utils.ts` is a module-level constant evaluated at import time:

```ts
export const CONFIG_DIR = resolveConfigDir(); // line 387
```

`resolveConfigDir()` reads `OPENCLAW_STATE_DIR` from `process.env`. But `src/infra/dotenv.ts`
is statically imported in `src/cli/run-main.ts`, which transitively imports `utils.ts` -
so `CONFIG_DIR` is frozen to the default `~/.openclaw` **before** `applyCliProfileEnv` runs
and sets `OPENCLAW_STATE_DIR` to the profile-specific path.

`runPluginInstallCommand` in `src/cli/plugins-cli.ts` called `installPluginFromNpmSpec` and
`installPluginFromPath` without passing `extensionsDir`, so both fell back to
`path.join(CONFIG_DIR, "extensions")` - always `~/.openclaw/extensions` regardless of profile.

The `uninstall` command (same file, line 595) already correctly called
`resolveStateDir(process.env, os.homedir)` at call time. Applied the same pattern to install.

**Fix:** Added `extensionsDir` computation via `resolveStateDir(process.env, os.homedir)` at
the top of `runPluginInstallCommand` and threaded it through to all three install call sites
(dryRun probe, path install, npm install). 5 lines changed.

**Verified:** All 13 existing plugin install tests pass. `pnpm tsgo` clean.

**Branch pushed:** `suboss87:fix/plugins-install-profile-extensions-dir`

**PR URL (open manually):** https://github.com/suboss87/openclaw/pull/new/fix/plugins-install-profile-extensions-dir
Upstream target: openclaw/openclaw, closes #69960

### Comment check

Unable to read PR comments on `openclaw/openclaw` (GitHub MCP write and read tools
restricted to `suboss87/openclaw`; only the search API reaches upstream). No comment
responses posted this run.

### Rebase check

Mergeable status not available via search API. All 4 open PRs were updated within the last
8 days so no automated rebase was attempted.

### PR review identified: #69270

PR #69270 by @de1tydev (fix(compaction): restore session invariants across compaction and
reset, agents+gateway, size:M, 3 comments) was the best candidate in our lanes.

Could not post review - MCP write tools are restricted to `suboss87/openclaw`.

Key observations from local code review (post manually if desired):

- `src/agents/pi-embedded-subscribe.handlers.compaction.ts` fires `before_compaction` /
  `after_compaction` hooks in two separate sites (subscribe-time ~line 848 and engine-owned
  ~line 1052). Each builds its hook context independently. Worth checking whether the PR
  centralizes this into a shared helper to prevent future drift, or patches each site
  separately.
- Verify the reset path correctly invalidates in-flight compaction state before reinitializing
  session invariants. A race between reset and a queued compaction could re-corrupt state
  even after the fix.

## Next Steps

1. Open upstream PR for the profile fix from
   https://github.com/suboss87/openclaw/pull/new/fix/plugins-install-profile-extensions-dir
2. Follow up on #66544 and #66225 (8 days old, no merge activity) - may need a ping or rebase.
3. Post the compaction review on #69270 manually if desired.
4. Check CI on #69685 and #68446 (both recent, should have results).
