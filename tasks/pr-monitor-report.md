# PR Monitor Report

**Date:** 2026-04-17 (run 27)
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

**Status:** CLOSED without merge — **closed_at: 2026-04-17T02:10:17Z** (NEW this run)

Was OPEN in run 25 (2026-04-16). Branch tip `46e2b30607303996c6423abd33ec854c42b57ac3` was
unchanged since 2026-04-06. No maintainer review or approval was ever recorded.

Prior outstanding issues now moot:
- Upstream rebase was required (mergeable: dirty) — no longer actionable.
- Monitoring artifact tip commit `46e2b30607` — no longer actionable.
- CI was blocked by dirty state — no longer actionable.

Close reason not visible from available API access (comment bodies inaccessible without full
`openclaw/openclaw` MCP scope or `gh` CLI). Likely closed due to staleness or upstream conflict.

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

**Status:** CLOSED without merge — **closed_at: 2026-04-17T02:10:15Z** (NEW this run)

Was OPEN in run 25 (2026-04-16). Branch tip `f052129db44607fed72a0769dc5de6b919bcd5dc` was
unchanged since 2026-04-06. No human maintainer review was ever recorded (only bot reviews,
which were addressed).

Prior outstanding issues now moot:
- CI failures (security-fast, contracts-protocol, ext shards 2/3/4/6) — no longer actionable.
- Monitoring artifact tip commits `d18c8771bb` + `f052129db4` — no longer actionable.
- Pending maintainer review — moot; PR closed before review occurred.

Close reason not visible from available API access (comment bodies inaccessible without full
`openclaw/openclaw` MCP scope or `gh` CLI). Closed at ~02:10 UTC 2026-04-17, 2 seconds after
#45584, suggesting a batch close by a maintainer.

**No action required.**

**Fork branch tip:** `f052129db44607fed72a0769dc5de6b919bcd5dc` (unchanged)

---

## Actions Taken This Run (run 27 — 2026-04-17)

**GitHub API access:** BLOCKED — MCP restricted to `suboss87/openclaw` (fork only); `gh` CLI
not installed; `openclaw/openclaw` PR/CI/review details are inaccessible via direct MCP calls.
`search_pull_requests` and `search_issues` provide partial read access (state, closed_at,
merged_at, comment counts, labels) but not comment/review bodies.

**Branch SHAs confirmed from fork (run 26 vs run 25):**

| Branch                                  | SHA (tip)                                  | Changed since run 25? |
| --------------------------------------- | ------------------------------------------ | --------------------- |
| fix/telegram-approval-callback-fallback | `14fd49c362b7d84b8fda157967befe2a0ca730f5` | No |
| feat/cron-fresh-session-option          | `46e2b30607303996c6423abd33ec854c42b57ac3` | No |
| fix/chat-send-button-contrast           | `76c2ea44d857b9ae68cf056dfc72c8e4d4cfcd64` | No |
| fix/subagent-identity-fallback          | `f052129db44607fed72a0769dc5de6b919bcd5dc` | No |

**Key changes since run 26:** None — all 4 monitored PRs remain in the same closed/merged state
confirmed in run 26. Fork branch SHAs also unchanged. No new activity on any monitored branch.

**New open PR activity noted (outside monitoring scope):**
- #66544 and #66225 both had recent activity at ~02:13–02:16 UTC today (same time window as the
  batch closes from run 26). Statuses unchanged from run 26 observation.

**Rebase:** Not attempted — all monitored PRs are closed; no further rebase needed.

**No code changes made this run.**

**Other open PRs by suboss87 (outside monitoring scope — noted for awareness):**

| PR | Title | Labels | Updated | Comments | Reactions |
| --- | --- | --- | --- | --- | --- |
| #66544 | fix(gateway): exclude heartbeat sender ID from session display name | gateway, size: XS | 2026-04-17T02:16:13Z | 3 | 👍×2 |
| #66225 | fix(agents): align final tag regexes to handle self-closing `<final/>` variant | agents, size: S | 2026-04-17T02:13:03Z | 4 | 👍×1 |
| #56978 | fix(whatsapp): exclude DM allowFrom from group policy sender bypass | channel: whatsapp-web, size: S | 2026-04-16T05:26:43Z | 4 | 👍×1 |
| #55787 | fix: strip orphaned OpenAI reasoning blocks before responses API call | agents, size: XS | 2026-04-16T05:26:30Z | 5 | 👍×3 |

Both #66544 and #66225 had activity at ~02:13–02:16 UTC today (same window as the batch closes).

**Recently merged by suboss87 (for reference):**
- openclaw/openclaw#67457 (`fix(ollama): strip provider prefix from model ID`) — merged 2026-04-16T05:45:38Z by `obviyus`
- openclaw/openclaw#64735 (`fix(hooks): pass workspaceDir in gateway session reset`) — merged 2026-04-14T01:19:07Z by `vincentkoc`

---

## PRs Requiring Human Attention

All four originally monitored PRs are now resolved (2 merged, 2 closed without merge). No
items from the original monitoring scope require further human attention.

The active open PRs (#66544, #66225, #56978, #55787) are outside the original monitoring
scope; they are noted for awareness only.

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
