# PR Monitor Report

**Date:** 2026-04-18 (run 28)
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

---

## PR #45911 — fix/telegram-approval-callback-fallback

**Status:** MERGED (merged_at: 2026-03-29T05:15:58Z)

Squash-merge by maintainer `obviyus`. No action required.

**Branch tip (fork):** `14fd49c362b7d84b8fda157967befe2a0ca730f5` (unchanged since run 16)

---

## PR #45584 — feat/cron-fresh-session-option

**Status:** CLOSED without merge — closed_at: 2026-04-17T02:10:17Z

Branch tip `46e2b30607303996c6423abd33ec854c42b57ac3` unchanged since 2026-04-06. No new activity
since run 27. No maintainer review or approval was ever recorded before close.

**No action required.**

**Fork branch tip:** `46e2b30607303996c6423abd33ec854c42b57ac3` (unchanged)

---

## PR #54363 — fix/chat-send-button-contrast

**Status:** CLOSED without merge (closed_at: 2026-03-27T14:12:49Z)

Closed without merge. Maintainer `velvet-shark` noted PR #55075 landed the same fix.
No action required.

**Fork branch tip:** `76c2ea44d857b9ae68cf056dfc72c8e4d4cfcd64` (unchanged)

---

## PR #54730 — fix/subagent-identity-fallback

**Status:** CLOSED without merge — closed_at: 2026-04-17T02:10:15Z

Branch tip `f052129db44607fed72a0769dc5de6b919bcd5dc` unchanged since 2026-04-06. No new activity
since run 27.

**No action required.**

**Fork branch tip:** `f052129db44607fed72a0769dc5de6b919bcd5dc` (unchanged)

---

## Actions Taken This Run (run 28 — 2026-04-18)

**GitHub API access:** Partial — MCP restricted to `suboss87/openclaw` (fork only); `gh` CLI
not installed; direct PR/CI/review details for `openclaw/openclaw` are inaccessible via MCP.
`search_pull_requests` and `search_issues` provide read access to state, timestamps, comment
counts, and labels.

**Branch SHAs confirmed from fork (run 28 vs run 27):**

| Branch                                  | SHA (tip)                                  | Changed since run 27? |
| --------------------------------------- | ------------------------------------------ | --------------------- |
| fix/telegram-approval-callback-fallback | `14fd49c362b7d84b8fda157967befe2a0ca730f5` | No |
| feat/cron-fresh-session-option          | `46e2b30607303996c6423abd33ec854c42b57ac3` | No |
| fix/chat-send-button-contrast           | `76c2ea44d857b9ae68cf056dfc72c8e4d4cfcd64` | No |
| fix/subagent-identity-fallback          | `f052129db44607fed72a0769dc5de6b919bcd5dc` | No |

**Key changes since run 27:** None — all 4 monitored PRs remain in the same closed/merged state.
Fork branch SHAs also unchanged. No new activity on any monitored branch.

**Open PR activity (outside monitoring scope):** No timestamp or comment count changes vs run 27.
All four active PRs (#66544, #66225, #56978, #55787) last updated 2026-04-16/17.

**Rebase:** Not attempted — all monitored PRs are closed; no rebase needed.

**No code changes made this run.**

---

## Open PRs by suboss87 (outside monitoring scope — noted for awareness)

| PR | Title | Labels | Updated | Comments | Reactions |
| --- | --- | --- | --- | --- | --- |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size: XS | 2026-04-17T02:16:13Z | 3 | 👍×2 |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size: S | 2026-04-17T02:13:03Z | 4 | 👍×1 |
| #56978 | fix(whatsapp): exclude DM allowFrom from group policy sender bypass | channel: whatsapp-web, size: S | 2026-04-16T05:26:43Z | 4 | 👍×1 |
| #55787 | fix: strip orphaned OpenAI reasoning blocks before responses API call | agents, size: XS | 2026-04-16T05:26:30Z | 5 | 👍×3 |

No activity change on any of these since run 27 (timestamps and comment counts identical).

**Recently merged by suboss87 (for reference):**
- openclaw/openclaw#67457 (`fix(ollama): strip provider prefix from model ID`) — merged 2026-04-16T05:45:38Z by `obviyus`
- openclaw/openclaw#64735 (`fix(hooks): pass workspaceDir in gateway session reset`) — merged 2026-04-14T01:19:07Z by `vincentkoc`

---

## PRs Requiring Human Attention

All four originally monitored PRs are resolved (1 merged, 3 closed without merge). No
items from the original monitoring scope require further human attention.

The four active open PRs (#66544, #66225, #56978, #55787) are outside the original monitoring
scope. #56978 has an assignee (`mcaxtr`) — may be awaiting maintainer review. No blockers
observed.

---

## Environment Constraints (ongoing)

- `gh` CLI not installed in this environment (`command not found`).
- GitHub MCP server is configured for `suboss87/openclaw` only; `openclaw/openclaw` PR CI
  check runs and review thread bodies are inaccessible via direct MCP calls.
- `search_pull_requests` and `search_issues` provide partial read access to `openclaw/openclaw`
  (PR state, closed_at/merged_at, comment counts, label state) but not full comment/review bodies.
- Upstream `openclaw/openclaw` remote not configured; git proxy not reachable for that repo.
- **Action required by operator:** Install `gh` CLI (authenticated) or extend MCP scope to
  `openclaw/openclaw` to restore full monitoring capability.

---

## Monitoring Artifact Contamination (standing note — now moot for monitored PRs)

Runs 3–9 accidentally committed `tasks/pr-monitor-report.md` updates to the PR branches
`feat/cron-fresh-session-option` and `fix/subagent-identity-fallback`. Those PRs are now
closed, so the artifact contamination is no longer a merge blocker. The fork branches retain
those artifact commits but no cleanup action is needed unless the branches are reused.
