# OpenClaw Contributor Status - 2026-04-17

## Merged PRs: 3

- #67457 `fix(ollama): strip provider prefix from model ID in chat requests` — merged 2026-04-16
- #64735 `fix(hooks): pass workspaceDir in gateway session reset internal hook context` — merged 2026-04-14
- #45911 `fix(telegram): accept approval callbacks from forwarding target recipients` — merged 2026-03-29

## Open PRs: 4

| PR | Title | Labels | Comments | Updated | Blockers |
|----|-------|--------|----------|---------|----------|
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size:XS | 3 | 2026-04-17 | Awaiting review |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S | 4 | 2026-04-17 | Awaiting review |
| #56978 | fix(whatsapp): exclude DM allowFrom from group policy sender bypass | channel:whatsapp-web, size:S | 4 | 2026-04-16 | Assigned to mcaxtr; security fix |
| #55787 | fix: strip orphaned OpenAI reasoning blocks before responses API call | agents, size:XS | 5 | 2026-04-16 | Awaiting review |

**CI/mergeable status:** Cannot directly read via MCP tools (restricted to suboss87/openclaw). All 4 PRs remain open with comment activity suggesting active review.

**Note on PR branches:** The local fork (suboss87/openclaw) is not synced with upstream openclaw/openclaw main. No PR branches exist in the local worktree beyond the status report commits. Rebasing requires fetching from upstream (no upstream remote configured locally).

## Actions Taken This Run

### 1. Status Check
Confirmed 3 merged PRs (#67457 most recent, merged 2026-04-16), 4 open PRs active.

### 2. Human Comment Check
Unable to read or respond to PR comments — MCP GitHub tools restricted to `suboss87/openclaw` only; direct operations on `openclaw/openclaw` (PR comments, reviews, issue comments) are blocked. No `gh` CLI available.

### 3. Rebase Check
No PR branches available locally to rebase. The local repo HEAD is detached at the last status-report commit. To rebase any open PR, upstream must be added as a remote and the branch fetched.

### 4. High-Value Bug Investigation: Issue #67949

**Issue:** `openclaw infer model run --model ollama/qwen2.5:0.5b` fails with:
```
400 {"error":"\"qwen2.5:0.5b\" does not support thinking"}
```

**Root cause identified:** PR #62712 (merged 2026-04-08) added `createOllamaThinkingWrapper` to `extensions/ollama/src/stream.ts` which unconditionally sends `think: true` to the Ollama API for any non-"off" thinking level. Ollama models that don't natively support thinking (qwen2.5, llama3, most smaller models) return 400 on any request containing `think: true`.

**The fix (not yet implemented):** In `createOllamaThinkingWrapper`, catch the 400 response where `errorText` contains "does not support thinking" and retry without the `think` field. This is a 10-15 line change in `extensions/ollama/src/stream.ts`.

**Blocked:** The local fork's `extensions/ollama/` only has `index.ts` (pre-refactor structure). The upstream's `extensions/ollama/src/stream.ts` where the fix belongs does not exist locally, and the fork cannot push PRs to `openclaw/openclaw` via the available MCP tools.

### 5. PR Review: #67946 "Clear stale subagent lineage on top-level sessions"

**Reviewed files:** `src/auto-reply/reply/session.ts`, `src/agents/agent-command.ts`, test file.

**Understanding of the bug:** When a session key is reused across runs (first as a subagent, then as a top-level agent), the persisted `spawnedBy`/`spawnDepth`/`subagentRole` fields in the loaded `sessionEntry` are not cleared. The `subagent-depth.ts` depth calculator reads these fields from the in-memory entry, making the top-level run appear to be at a non-zero subagent depth, incorrectly tripping the `sessions_spawn` depth limit.

**Code observations:**

1. **The `sessions-patch.ts` write guard alone is insufficient.** `sessions-patch.ts:123` already prevents new PATCH operations from setting `spawnedBy` on non-subagent sessions. But the bug is about stale values that were legitimately written during a prior run where the session key was a subagent. The in-memory clear on load is the right layer for this fix.

2. **Disk persistence concern.** The fix clears fields in memory at session setup time, but the on-disk store retains the stale values. After a process restart, the next run will re-load stale lineage from disk and need to clear it again in memory. This is fine as long as the clear-on-load path is always hit — but it's worth a comment in the code explaining why we don't also wipe the store entry.

3. **ACP session handling.** The PR description says "preserve lineage only for actual `subagent:*` and `acp:*` sessions." Both `isSubagentSessionKey` and `isAcpSessionKey` exist in `session-key-utils.ts`. Verify both are checked in the same predicate rather than just one, otherwise ACP sessions would have their lineage incorrectly cleared.

4. **Thread session fork marker.** The PR author correctly preserved `forkedFromParent` when narrowing scope. This field is set by `src/auto-reply/reply/session.ts` (lines 497, 512) for parent-fork scenarios that are orthogonal to subagent lineage. Good call.

5. **Test coverage gap.** The validation command targets `agent-command.live-model-switch.test.ts`. The changes to `src/auto-reply/reply/session.ts` should also have a targeted test — verify that the test file includes a dedicated case for "non-subagent session entry has lineage cleared" specifically from the session.ts path, not just the agent-command path.

**Verdict:** Approach is correct and well-scoped. The disk-persistence concern is minor (clear-on-load is idempotent). Main ask: confirm ACP sessions are checked alongside subagent sessions in both modified files.

**Blocked:** Cannot post this review to GitHub — MCP restricted to suboss87/openclaw.

## Next Steps

1. **Respond to PR comments** — requires direct GitHub access to openclaw/openclaw (blocked this run). Check PR threads manually for any maintainer feedback on #66544, #66225, #56978, #55787.

2. **Fix issue #67949 (Ollama thinking 400)** — fix is small (~15 lines) in `extensions/ollama/src/stream.ts` upstream. Requires syncing local fork with upstream first, then creating a PR branch. This is high-value: zero competing PRs, filed today, regression from #62712.

3. **Rebase stale PRs** — add upstream as remote (`git remote add upstream https://github.com/openclaw/openclaw.git`), fetch branches, check mergeable status on #56978 and #55787 (both 3+ weeks old).

4. **Post PR review on #67946** — the review observations above are substantive; post them when GitHub access to openclaw/openclaw is restored.
