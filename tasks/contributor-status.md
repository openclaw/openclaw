# OpenClaw Contributor Status - 2026-04-18

## Merged PRs: 3

- #67457 `fix(ollama): strip provider prefix from model ID in chat requests` — merged 2026-04-16
- #64735 `fix(hooks): pass workspaceDir in gateway session reset internal hook context` — merged 2026-04-14
- #45911 `fix(telegram): accept approval callbacks from forwarding target recipients` — merged 2026-03-29

## Open PRs: 4

| PR | Title | Labels | Comments | Updated | Status |
|----|-------|--------|----------|---------|--------|
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size:XS | 3 | 2026-04-17 | Awaiting review, +2 reactions |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size:S | 4 | 2026-04-17 | Awaiting review, +1 reaction |
| #56978 | fix(whatsapp): exclude DM allowFrom from group policy sender bypass | channel:whatsapp-web, size:S | 4 | 2026-04-16 | Assigned to @mcaxtr |
| #55787 | fix: strip orphaned OpenAI reasoning blocks before responses API call | agents, size:XS | 5 | 2026-04-16 | Awaiting review, +3 reactions |

**Note on CI/mergeability:** Cannot read directly via MCP tools (restricted to suboss87/openclaw). No new merges since #67457 on 2026-04-16.

## Actions Taken This Run

### 1. Status Check
Confirmed 3 merged PRs and 4 open PRs. Last merge was #67457 on 2026-04-16 (Ollama prefix strip).
All 4 open PRs updated between 2026-04-16 and 2026-04-17 — comment activity is happening but none merged yet.

### 2. Human Comment Check
MCP GitHub tools are restricted to `suboss87/openclaw` only. Direct operations on `openclaw/openclaw`
(issue comments, PR reviews, reading PR comments) are blocked. Cannot respond to human comments
this run. No `gh` CLI available as an alternative.

### 3. Rebase Check
Cannot read PR mergeable status via MCP tools. No upstream remote configured in local worktree
to check branch divergence. PR branches are in the upstream fork, not the local worktree.

### 4. Bug Investigation

Scanned fresh bugs filed 2026-04-17/18. Prioritized regressions with zero assignees.

**Investigated: #68272 (image attachments dropped for MiniMax-M2.7)**
Root cause in issue report: `parseMessageWithAttachments()` drops attachments when the model
catalog entry is not found due to a provider-prefix mismatch (e.g., `minimax/MiniMax-M2.7`
vs catalog entry `MiniMax-M2.7`). Local fork's `chat-attachments.ts` does not contain the
model capability check — that code path is in a newer upstream version not yet in the fork.
Cannot fix this run.

**Investigated: #68347 (Schema .strict() rejects `paperclip` property)**
Already closed as completed by maintainers on 2026-04-18 before this run.

**Investigated: #68237 (SecretRef regression in Slack socket-mode reply)**
Root cause is clear from the bug report: the Slack reply path calls
`resolveSlackAccount({ cfg })` against raw config rather than the already-resolved
`SlackMonitorContext.botToken`, causing strict-mode SecretRef validation to fail.
The monitor code at `extensions/slack/src/monitor/message-handler/dispatch.ts` is not
present in the local fork. Cannot fix this run.

### 5. PR Review (PR #68296 by 1aifanatic)

**PR:** fix(agents): add `file` and `filePath` aliases to read tool diagnostic path check
**Size:** XS — extends a 4-line ternary chain in `handleToolExecutionStart`

**Code location verified:** `src/agents/pi-embedded-subscribe.handlers.tools.ts:319-324`

Current code:
```typescript
const filePathValue =
  typeof record.path === "string"
    ? record.path
    : typeof record.file_path === "string"
      ? record.file_path
      : "";
```

The PR extends this to also check `record.file` and `record.filePath`.

**Observations:**
- The fix is correct: `handleToolExecutionStart` fires before `normalizeToolParams()` runs,
  so the diagnostic guard sees raw model-emitted params. If Claude sends `file: "..."`,
  the existing check produces a false-positive warning.
- One gap: `normalizeToolParams()` in `pi-tools.params.ts` only maps `file_path` → `path`.
  If a model sends `file` or `filePath` as the param name, the tool itself may not work
  correctly (not just log a false warning). Worth noting in review — the diagnostic fix is
  necessary but the normalization might need a companion patch.
- Test coverage looks solid for the diagnostic change itself; a test verifying actual
  tool execution succeeds with `file` param (not just warning suppression) would strengthen
  the PR.

**Cannot post review** — MCP tools restricted to suboss87/openclaw.

## Next Steps

1. Monitor #66544 and #66225 — both have reactions and comments, likely approaching merge
2. Watch #56978 (whatsapp security fix) — assigned to @mcaxtr for review
3. Watch #55787 (OpenAI reasoning) — 3 upvotes, good candidate for next merge
4. When MCP access to openclaw/openclaw is restored: respond to any unanswered review comments
5. Look for new bugs to fix — #68237 (Slack SecretRef) is high-impact when fork is synced
6. Consider syncing fork with upstream main to pick up newer extension code
