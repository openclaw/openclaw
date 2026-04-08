# PR Monitor Report

**Date:** 2026-04-08 (run 14)
**Contributor:** suboss87
**Repo:** openclaw/openclaw

---

## PRs Checked

| PR     | Branch                                  | Status | CI                           | Review                         | Conflicts (fork/main)       | Actions Taken               |
| ------ | --------------------------------------- | ------ | ---------------------------- | ------------------------------ | --------------------------- | --------------------------- |
| #45911 | fix/telegram-approval-callback-fallback | MERGED | N/A                          | N/A                            | N/A                         | None (already merged)       |
| #45584 | feat/cron-fresh-session-option          | OPEN   | Unknown (no GitHub API)      | Bot comments addressed in code | None (resolved vs run 13)   | None — no new activity      |
| #54363 | fix/chat-send-button-contrast           | CLOSED | N/A                          | N/A                            | N/A                         | None (closed without merge) |
| #54730 | fix/subagent-identity-fallback          | OPEN   | GREEN (success, from run 12) | No open reviews                | None (resolved vs run 13)   | None — no new activity      |

---

## PR #45911 — fix/telegram-approval-callback-fallback

**Status:** MERGED (closed 2026-03-29T05:15:58Z)

Branch still exists in fork at SHA `14fd49c362b7d84b8fda157967befe2a0ca730f5` (unchanged since
run 12). No action required.

---

## PR #45584 — feat/cron-fresh-session-option

**Status:** OPEN | **Branch:** `feat/cron-fresh-session-option`
**Head SHA:** `46e2b30607303996c6423abd33ec854c42b57ac3` (unchanged since run 9 — no new commits)

**Git-based conflict analysis (run 14):**
`git merge-tree` against fork's `origin/main` shows **no conflict markers** in any file.
The `tasks/pr-monitor-report.md` conflict from run 13 is resolved — fork main has advanced
past the conflicting state. No conflicts in actual PR code files
(`src/cron/`, `src/gateway/protocol/schema/cron.ts`, Swift models).

**CI:** Unknown — no GitHub API access to check current check-run state. Last known: label
checks passing; main CI pass depended on Swift model regeneration commit (`569a0bdfa`).

**Review comments (2, from 2026-03-14 — no new comments since run 9):**

1. `greptile-apps[bot]` on `src/cron/types-shared.ts` — JSDoc "Defaults to true for isolated
   sessions" inaccurate.
   **Status: Addressed in code.** Current JSDoc: "When omitted, falls back to the session-target
   default: isolated sessions default to fresh, others default to reuse."

2. `chatgpt-codex-connector[bot]` P1 on `src/gateway/protocol/schema/cron.ts:74` —
   `freshSession` not persisted in `createJob`/`applyJobPatch`.
   **Status: Addressed in code.** `src/cron/service/jobs.ts:542` assigns
   `freshSession: input.freshSession`; lines 580-581 apply the patch conditionally.

Neither bot has re-reviewed; conversations may still show as unresolved on GitHub.

**Branch contamination (needs human attention):**
Monitoring-run artifacts are on this PR branch (touch only `tasks/pr-monitor-report.md`):

- `89065a6b2 chore(tasks): add PR monitor report for suboss87 PRs` (4th from tip)
- `46e2b3060 chore(format): fix markdown formatting in pr-monitor-report` (tip commit)

The legitimate PR commits are:
- `cb7f5c963 feat(cron): add freshSession option to control session reuse per job`
- `569a0bdfa chore(protocol): regenerate Swift models for freshSession cron field`

**Needs human attention:**

1. Clean up monitoring-artifact commits (`89065a6b2`, `46e2b3060`) from the branch before merge
   via interactive rebase — these add `tasks/pr-monitor-report.md` to the PR diff.
2. Rebase against upstream `openclaw/openclaw:main` (cannot verify from this environment; last
   known dirty state may have cleared, but confirm before merge).
3. Re-trigger main CI to confirm all checks pass after the Swift protocol regeneration.

---

## PR #54363 — fix/chat-send-button-contrast

**Status:** CLOSED (2026-03-27T14:12:49Z, not merged)

Branch still exists in fork at SHA `76c2ea44d857b9ae68cf056dfc72c8e4d4cfcd64`. No action
required.

---

## PR #54730 — fix/subagent-identity-fallback

**Status:** OPEN | **Branch:** `fix/subagent-identity-fallback`
**Head SHA:** `f052129db44607fed72a0769dc5de6b919bcd5dc` (unchanged since run 9 — no new commits)

**Git-based conflict analysis (run 14):**
`git merge-tree` against fork's `origin/main` shows **no conflict markers** in any file.
The 7 conflict markers in `tasks/pr-monitor-report.md` reported in run 13 are resolved — fork
main has advanced past the conflicting state. No conflicts in actual PR code files
(`src/gateway/assistant-identity.ts`, `src/gateway/assistant-identity.test.ts`).

**CI:** GREEN (success) — last confirmed passing in run 12. No new commits since; status
should still hold.

**Review comments:** No reviews from any reviewer on this PR.

**Branch contamination (needs human attention):**
Monitoring-run artifacts are the top commits on this PR branch (touch only
`tasks/pr-monitor-report.md`):

- `f052129db chore(tasks): update PR monitor report for suboss87 PRs (2026-04-06 run 9)` (tip)
- `d18c8771b chore(format): fix markdown formatting in pr-monitor-report` (2nd)
- `89065a6b2 chore(tasks): add PR monitor report for suboss87 PRs` (5th)

The actual PR fix commits are:
- `7870292d6 fix(ui): prefer per-agent identity for subagents over global ui.assistant`
- `8fb20f890 refactor: hoist resolveDefaultAgentId to avoid redundant call`

**Needs human attention:**

1. Clean up monitoring-artifact commits (`f052129db`, `d18c8771b`, `89065a6b2`) from the branch
   before merge via interactive rebase — these add `tasks/pr-monitor-report.md` to the PR diff.
2. CI is passing; PR fix is otherwise complete and ready for review/merge once contamination is
   cleaned.

---

## Actions Taken This Run (run 14 — 2026-04-08)

**None — blocked by missing GitHub access (same as runs 11-13).**

This run could not query any live PR data from GitHub:

- `gh` CLI: not installed in this environment
- GitHub MCP server tools (`mcp__github__*`): not loaded (ToolSearch returned no matches)
- Unauthenticated GitHub REST API: no auth token available

**What was verified via git (without GitHub API):**

- All 4 PR branches still exist in fork (`suboss87/openclaw`) with unchanged tip SHAs vs run 13.
- `git merge-tree` against fork `origin/main` shows **no conflict markers** in any of the 4
  branches. The `tasks/pr-monitor-report.md` conflicts reported in run 13 are now resolved (fork
  main has advanced). No code file conflicts exist in any branch.
- Branch SHAs unchanged since the last commit activity (run 9 for #45584 and #54730).
- Upstream `openclaw/openclaw:main` conflict state for #45584 cannot be verified from this
  environment (only fork remote is accessible).

PR statuses, CI conclusions, and review states carried over from runs 12-13. They may be stale.
Human review is required to confirm current GitHub state.

**To unblock future monitoring runs**, one of the following must be in place:

1. Install `gh` CLI in the environment and authenticate (`gh auth login`), OR
2. Register the GitHub MCP server so that `mcp__github__*` tools appear in the session.

---

## PRs Requiring Human Attention

- openclaw/openclaw#45584
  - **Branch contamination:** remove monitoring-artifact commits before merge (`89065a6b2`,
    `46e2b3060` touch only `tasks/pr-monitor-report.md`)
  - **Rebase check:** verify clean state against upstream `openclaw/openclaw:main` before merge
  - **Re-trigger CI** for full test/build pass after Swift protocol regeneration

- openclaw/openclaw#54730
  - **Branch contamination:** remove monitoring-artifact commits (`f052129db`, `d18c8771b`,
    `89065a6b2`) before merge — these add unrelated `tasks/pr-monitor-report.md` to the PR diff
  - CI is green; PR fix is complete and ready for review/merge once contamination is cleaned
