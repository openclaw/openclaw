# PR Monitor Report

**Date:** 2026-04-07 (run 12)
**Contributor:** suboss87
**Repo:** openclaw/openclaw

---

## PRs Checked

| PR     | Branch                                  | Status | CI                                                  | Review                         | Conflicts                | Actions Taken               |
| ------ | --------------------------------------- | ------ | --------------------------------------------------- | ------------------------------ | ------------------------ | --------------------------- |
| #45911 | fix/telegram-approval-callback-fallback | MERGED | N/A                                                 | N/A                            | N/A                      | None (already merged)       |
| #45584 | feat/cron-fresh-session-option          | OPEN   | Label checks pass; main CI unknown (no new trigger) | Bot comments addressed in code | Unknown (GitHub pending) | None — no new activity      |
| #54363 | fix/chat-send-button-contrast           | CLOSED | N/A                                                 | N/A                            | N/A                      | None (closed without merge) |
| #54730 | fix/subagent-identity-fallback          | OPEN   | GREEN (success)                                     | No open reviews                | Unknown (GitHub pending) | None — no new activity      |

---

## PR #45911 — fix/telegram-approval-callback-fallback

**Status:** MERGED (closed 2026-03-29T05:15:58Z)

No action required. Branch still exists in fork but PR is closed and merged.

---

## PR #45584 — feat/cron-fresh-session-option

**Status:** OPEN | **Branch:** `feat/cron-fresh-session-option`
**Last updated:** 2026-04-06T03:49:37Z (run 9 commit — no new human activity)
**Head SHA:** `46e2b30607303996c6423abd33ec854c42b57ac3`

**CI:** Only label check-runs visible for head SHA (3 checks: backfill-pr-labels/skipped,
label/success, label-issues/success). Main GitHub Actions CI was not triggered for the tip
commit (`chore(format)` touches only `tasks/pr-monitor-report.md`, likely excluded by path
filters). Previously fixed protocol check failure (Swift models regenerated in run 9) should
still hold.

**Review comments (2, both from 2026-03-14 — no new comments since run 9):**

1. `greptile-apps[bot]` on `src/cron/types-shared.ts` — JSDoc "Defaults to true for isolated
   sessions" is inaccurate.
   **Status: Addressed in code.** Current JSDoc: "When omitted, falls back to the session-target
   default: isolated sessions default to fresh, others default to reuse." — correct.

2. `chatgpt-codex-connector[bot]` P1 on `src/gateway/protocol/schema/cron.ts:74` — `freshSession`
   not persisted in `createJob`/`applyJobPatch`.
   **Status: Addressed in code.** `src/cron/service/jobs.ts:542` assigns
   `freshSession: input.freshSession`; lines 580–581 apply the patch conditionally.

Neither bot has re-reviewed; conversations may still show as unresolved on GitHub.

**Merge conflicts:** `mergeable_state` returned `unknown` (GitHub still computing at check time).
Previous run showed `dirty`; author should check and rebase against upstream if needed.

**Branch contamination (needs human attention):**
Monitoring-run artifacts are on this PR branch:

- `89065a6b2 chore(tasks): add PR monitor report for suboss87 PRs` (4th commit from tip)
- `46e2b3060 chore(format): fix markdown formatting in pr-monitor-report` (tip commit)

Both touch only `tasks/pr-monitor-report.md`. These appear in the PR diff against
`openclaw/openclaw:main` and should be removed via interactive rebase before merging. Note:
`569a0bdfa chore(protocol): regenerate Swift models for freshSession cron field` is a
**legitimate** PR commit (required by the schema change).

**Needs human attention:**

1. Rebase against upstream `openclaw/openclaw:main` to resolve dirty merge state.
2. Clean up monitoring-artifact commits (`89065a6b2` and `46e2b3060`) from the branch before
   merge.
3. Re-trigger main CI to confirm all checks pass after the Swift protocol regeneration.

---

## PR #54363 — fix/chat-send-button-contrast

**Status:** CLOSED (2026-03-27T14:12:49Z, not merged)

No action required.

---

## PR #54730 — fix/subagent-identity-fallback

**Status:** OPEN | **Branch:** `fix/subagent-identity-fallback`
**Last updated:** 2026-04-06T03:51:54Z (run 9 commit — no new human activity)
**Head SHA:** `f052129db44607fed72a0769dc5de6b919bcd5dc`

**CI:** GREEN — 1 GitHub Actions check suite on head SHA: `status=completed conclusion=success`.
Previously stale/failing CI is now confirmed passing.

**Review comments:** No reviews from any reviewer on this PR.

**Merge conflicts:** `mergeable_state` returned `unknown` (GitHub still computing at check time).
Previous run showed clean (no conflicts).

**Branch contamination (needs human attention):**
Monitoring-run artifacts are the top commits on this PR branch:

- `f052129db chore(tasks): update PR monitor report for suboss87 PRs (2026-04-06 run 9)` (tip)
- `d18c8771b chore(format): fix markdown formatting in pr-monitor-report` (2nd)
- `89065a6b2 chore(tasks): add PR monitor report for suboss87 PRs` (5th)

All three touch only `tasks/pr-monitor-report.md`. They appear in the PR diff against
`openclaw/openclaw:main` alongside the actual fix files (`src/gateway/assistant-identity.ts`,
`src/gateway/assistant-identity.test.ts`). These should be removed via interactive rebase before
merging.

The actual PR fix commits are:

- `7870292d6 fix(ui): prefer per-agent identity for subagents over global ui.assistant`
- `8fb20f890 refactor: hoist resolveDefaultAgentId to avoid redundant call`

**Needs human attention:**

1. Clean up monitoring-artifact commits (`f052129db`, `d18c8771b`, `89065a6b2`) from branch
   before merge — these add `tasks/pr-monitor-report.md` to the PR diff.
2. CI is passing; PR is otherwise ready for review.

---

## Actions Taken This Run (run 12 — 2026-04-07)

**None — blocked by missing GitHub access.**

This run could not query any PR data:

- `gh` CLI: not installed in this environment (`command not found`)
- GitHub MCP server tools (`mcp__github__*`): not loaded (ToolSearch returned no matches for `mcp__github__get_pull_request` or related tools)
- Unauthenticated GitHub REST API: not attempted (no auth token; system instructions prohibit direct API access)

PR statuses, CI, reviews, and merge-conflict state in this report are carried over from run 10 (2026-04-06).
They may be stale. Human review is required to confirm current state.

**To unblock future monitoring runs**, one of the following must be in place:

1. Install `gh` CLI in the environment and authenticate (`gh auth login`), OR
2. Register the GitHub MCP server so that `mcp__github__*` tools appear in the session.

---

## PRs Requiring Human Attention

- openclaw/openclaw#45584
  - **Branch contamination:** remove monitoring-artifact commits before merge (`89065a6b2`,
    `46e2b3060` touch only `tasks/pr-monitor-report.md`)
  - **Rebase needed:** upstream dirty merge state from run 9 likely still applies; rebase against
    `openclaw/openclaw:main`
  - **Re-trigger CI** for full test/build pass after Swift protocol regeneration

- openclaw/openclaw#54730
  - **Branch contamination:** remove monitoring-artifact commits (`f052129db`, `d18c8771b`,
    `89065a6b2`) before merge — these add unrelated `tasks/pr-monitor-report.md` changes to the
    PR diff
  - CI is green; PR fix is otherwise complete and ready for review
