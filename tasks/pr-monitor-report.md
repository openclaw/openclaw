# PR Monitor Report

**Date:** 2026-04-22 (run 33)
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

No change to any of the four originally monitored PRs since run 32.

---

## PR #45911 — fix/telegram-approval-callback-fallback

**Status:** MERGED (merged_at: 2026-03-29T05:15:58Z by `obviyus`). No action required.

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

## Actions Taken This Run (run 33 — 2026-04-22)

**GitHub API access:** Partial — MCP restricted to `suboss87/openclaw` (fork only); `gh` CLI
not installed; PR comment/review bodies for `openclaw/openclaw` are inaccessible via MCP.
`search_pull_requests` provides read access to state, timestamps, comment counts, and labels.

**No code changes made this run.**
**No rebases needed** — all four monitored PRs are closed.

---

## Notable Activity Since Run 32 (2026-04-22)

No new activity. All four open PRs are unchanged:

- #69685: 2 comments, last updated 2026-04-21T11:04:21Z (unchanged)
- #68446: 2 comments, last updated 2026-04-18T07:19:26Z (unchanged)
- #66544: 3 comments, last updated 2026-04-19T00:33:48Z (unchanged)
- #66225: 5 comments, last updated 2026-04-19T00:34:20Z (unchanged)

---

## Open PRs by suboss87 (current — 4 total)

| PR | Title | Labels | Updated | Comments | Reactions |
| --- | --- | --- | --- | --- | --- |
| #69685 | fix(agents): strip final tags from persisted assistant message | agents, size: M | 2026-04-21T11:04:21Z | 2 | 👍×1 |
| #68446 | fix(whatsapp): stop DM allowFrom fallback into group policy sender bypass | channel: whatsapp-web, size: XS | 2026-04-18T07:19:26Z | 2 | 👍×1 |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size: XS | 2026-04-19T00:33:48Z | 3 | 👍×1 |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size: S | 2026-04-19T00:34:20Z | 5 | 👍×1 |

---

## PRs Requiring Human Attention

1. **#69685** — Opened 2026-04-21; companion to #66225. 2 comments (review thread content
   inaccessible due to MCP scope limit). Check for any early review feedback.
   https://github.com/openclaw/openclaw/pull/69685

2. **#66225** — 5 comments as of 2026-04-19T00:34:20Z (unchanged from run 28 through run 33).
   Review thread content inaccessible. Check for outstanding code change requests.
   https://github.com/openclaw/openclaw/pull/66225

3. **#68446** — 2 comments, open since 2026-04-18, no activity since. Supersedes closed #56978.
   https://github.com/openclaw/openclaw/pull/68446

4. **#66544** — 3 comments, open since 2026-04-14, last activity 2026-04-19.
   https://github.com/openclaw/openclaw/pull/66544

All four originally monitored PRs (#45911, #45584, #54363, #54730) remain resolved with
no further action needed.

---

## Branch SHAs (confirmed run 33 vs run 28)

| Branch                                  | SHA (tip)                                  | Changed since run 28? |
| --------------------------------------- | ------------------------------------------ | --------------------- |
| fix/telegram-approval-callback-fallback | `14fd49c362b7d84b8fda157967befe2a0ca730f5` | No |
| feat/cron-fresh-session-option          | `46e2b30607303996c6423abd33ec854c42b57ac3` | No |
| fix/chat-send-button-contrast           | `76c2ea44d857b9ae68cf056dfc72c8e4d4cfcd64` | No |
| fix/subagent-identity-fallback          | `f052129db44607fed72a0769dc5de6b919bcd5dc` | No |

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
