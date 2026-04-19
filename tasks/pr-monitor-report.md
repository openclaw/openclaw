# PR Monitor Report

**Date:** 2026-04-19 (run 29)
**Contributor:** suboss87
**Repo:** openclaw/openclaw

---

## PRs Checked

| PR     | Branch                                  | Status | CI  | Review | Conflicts | Actions Taken |
| ------ | --------------------------------------- | ------ | --- | ------ | --------- | ------------- |
| #45911 | fix/telegram-approval-callback-fallback | MERGED (2026-03-29) | N/A | N/A | N/A | None (already merged) |
| #45584 | feat/cron-fresh-session-option          | CLOSED without merge (2026-04-17) | N/A | N/A | N/A | None (closed by maintainer) |
| #54363 | fix/chat-send-button-contrast           | CLOSED without merge (2026-03-27) | N/A | N/A | N/A | None (closed without merge) |
| #54730 | fix/subagent-identity-fallback          | CLOSED without merge (2026-04-17) | N/A | N/A | N/A | None (closed by maintainer) |

No change to any of the four originally monitored PRs since run 28.

---

## PR #45911 — fix/telegram-approval-callback-fallback

**Status:** MERGED (merged_at: 2026-03-29T05:15:58Z). No action required.

---

## PR #45584 — feat/cron-fresh-session-option

**Status:** CLOSED without merge — closed_at: 2026-04-17T02:10:17Z. No action required.

---

## PR #54363 — fix/chat-send-button-contrast

**Status:** CLOSED without merge (closed_at: 2026-03-27T14:12:49Z). No action required.

---

## PR #54730 — fix/subagent-identity-fallback

**Status:** CLOSED without merge — closed_at: 2026-04-17T02:10:15Z. No action required.

---

## Actions Taken This Run (run 29 — 2026-04-19)

**GitHub API access:** Partial — MCP restricted to `suboss87/openclaw` (fork only); `gh` CLI
not installed; PR comment/review bodies for `openclaw/openclaw` are inaccessible via MCP.
`search_pull_requests` provides read access to state, timestamps, comment counts, and labels.

**No code changes made this run.**
**No rebases needed** — all four monitored PRs are closed.

---

## Notable Activity Since Run 28 (2026-04-18)

### #55787 — MERGED today
- **PR:** fix: strip orphaned OpenAI reasoning blocks before responses API call
- **Merged:** 2026-04-19T07:57:03Z by `jalehman`
- Was open as of run 28 (assigned to `jalehman`). Now closed/merged.
- https://github.com/openclaw/openclaw/pull/55787

### #56978 — NOW CLOSED (was open in run 28)
- **PR:** fix(whatsapp): exclude DM allowFrom from group policy sender bypass
- No longer in open PRs list as of this run.
- Superseded by #68446 (opened 2026-04-18), which targets the same bug against the
  current refactored code path. Author opened #68446 as the canonical replacement.
- https://github.com/openclaw/openclaw/pull/56978

### #68446 — NEW open PR (opened 2026-04-18)
- **PR:** fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass
- Supersedes #56978. One-line fix: `const groupAllowFrom = account.groupAllowFrom ?? [];`
- Labels: channel: whatsapp-web, size: XS. 2 comments. 👍×1
- Created: 2026-04-18T07:03:38Z, last updated: 2026-04-18T07:19:26Z
- https://github.com/openclaw/openclaw/pull/68446

### #66225 — New comment activity today
- **PR:** fix(agents): align final tag regexes to handle self-closing `<final/>` variant
- Comment count: 4 → **5** (new comment posted 2026-04-19)
- Updated: 2026-04-19T00:34:20Z (up from 2026-04-17T02:13:03Z)
- **⚠ Needs human check** — new comment content inaccessible via MCP; may be review
  feedback requiring a response or code change.
- https://github.com/openclaw/openclaw/pull/66225

### #66544 — Timestamp bump today, no new comment
- **PR:** fix(gateway): exclude heartbeat sender ID from session display name
- Comment count: 3 (unchanged)
- Updated: 2026-04-19T00:33:48Z (up from 2026-04-17T02:16:13Z)
- Timestamp change without comment count change likely indicates a review event, label
  change, or PR edit. **Low priority** — no new discussion to respond to.
- https://github.com/openclaw/openclaw/pull/66544

---

## Open PRs by suboss87 (current — 3 total)

| PR | Title | Labels | Updated | Comments | Reactions |
| --- | --- | --- | --- | --- | --- |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass | channel: whatsapp-web, size: XS | 2026-04-18T07:19:26Z | 2 | 👍×1 |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size: XS | 2026-04-19T00:33:48Z | 3 | 👍×1 |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size: S | 2026-04-19T00:34:20Z | 5 | 👍×1 |

---

## PRs Requiring Human Attention

1. **#66225** — New comment posted today (comment count 4→5). Review/feedback body is
   inaccessible in this session (MCP restricted to fork only). Check for code change
   requests or review threads that need a reply or fix.
   https://github.com/openclaw/openclaw/pull/66225

All four originally monitored PRs (#45911, #45584, #54363, #54730) remain resolved with
no further action needed.

---

## Recently Merged by suboss87 (reference)

| PR | Title | Merged |
| --- | --- | --- |
| #55787 | fix: strip orphaned OpenAI reasoning blocks before responses API call | 2026-04-19T07:57:03Z (`jalehman`) |
| #67457 | fix(ollama): strip provider prefix from model ID in chat requests | 2026-04-16T05:45:38Z (`obviyus`) |
| #64735 | fix(hooks): pass workspaceDir in gateway session reset internal hook context | 2026-04-14T01:19:07Z (`vincentkoc`) |
| #45911 | fix(telegram): accept approval callbacks from forwarding target recipients | 2026-03-29T05:15:58Z (`obviyus`) |

---

## Environment Constraints (ongoing)

- `gh` CLI not installed in this environment (`command not found`).
- GitHub MCP server is configured for `suboss87/openclaw` only; `openclaw/openclaw` PR CI
  check runs and review thread/comment bodies are inaccessible via direct MCP calls.
- `search_pull_requests` provides partial read access to `openclaw/openclaw` (PR state,
  timestamps, comment counts, labels) but not full comment/review bodies.
- **Action required by operator:** Install `gh` CLI (authenticated) or extend MCP scope to
  `openclaw/openclaw` to restore full monitoring capability (including review thread content).

---

## Monitoring Artifact Contamination (standing note — moot)

Runs 3–9 accidentally committed `tasks/pr-monitor-report.md` updates to branches
`feat/cron-fresh-session-option` and `fix/subagent-identity-fallback`. Both PRs are now
closed, so this is no longer a merge blocker.
