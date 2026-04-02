# PR Monitor Report

**Date:** 2026-04-02  
**Contributor:** suboss87  
**Repo:** openclaw/openclaw  
**Note:** GitHub API not available (no `gh` CLI or `mcp__github__*` tools). Analysis performed via git inspection of the fork remote (`suboss87/openclaw`).

---

## PRs Checked

| PR | Branch | Status | Merge Conflicts | Actions Taken |
|----|--------|--------|-----------------|---------------|
| #45911 | fix/telegram-approval-callback-fallback | **MERGED** | N/A | None |
| #45584 | feat/cron-fresh-session-option | Open | ~~Yes~~ → Resolved | Rebased onto main, force-pushed |
| #54363 | fix/chat-send-button-contrast | Open | Yes — **Obsolete** | None (see notes) |
| #54730 | fix/subagent-identity-fallback | Open | ~~Yes~~ → Resolved | Rebased onto main, force-pushed |

---

## PR Detail

### #45911 — fix/telegram-approval-callback-fallback — MERGED

The branch tip commit is:
```
14fd49c36 fix: keep telegram plugin fallback explicit (#45911) (thanks @suboss87)
Author: Ayaan Zaidi <hi@obviy.us>
Date:   Sun Mar 29 10:44:27 2026 +0530
```
The commit was authored by a maintainer (Ayaan Zaidi) with the upstream squash-merge format `(#45911) (thanks @suboss87)`. This confirms the PR was merged upstream. No action needed.

---

### #45584 — feat/cron-fresh-session-option — Open, Rebased

**Contribution:** Single commit (`55edd323f`) by suboss87 adding a `freshSession` boolean to cron job config. Touches:
- `src/cron/isolated-agent/run.ts`
- `src/cron/isolated-agent/session.test.ts`
- `src/cron/isolated-agent/run.skill-filter.test.ts`
- `src/cron/service/jobs.ts`
- `src/cron/types-shared.ts`
- `src/gateway/protocol/schema/cron.ts`

**Conflict situation:** Branch was 3+ weeks behind main (merge-base 2026-03-13). Cherry-pick onto current main applied cleanly with auto-merge.

**Action taken:** Rebased branch onto current main via cherry-pick. Force-pushed to `origin/feat/cron-fresh-session-option`.
- Old tip: `55edd323fd3df7b582a48fb174d5f46ed1e7a186`
- New tip: `cb7f5c963...` (clean cherry-pick on main)

**Needs human attention:** Cannot post rebase comment to PR (no GitHub access). Maintainer should note rebase and re-run CI.

---

### #54363 — fix/chat-send-button-contrast — Open, Needs Human Attention

**Contribution:** Single commit (`76c2ea44d`) by suboss87 fixing WCAG AA contrast on `.chat-send-btn` icon by changing `color: var(--text-strong)` → `color: #fff` against `background: var(--muted-strong)`.

**Conflict situation:** The upstream main redesigned `.chat-send-btn` after the PR was opened:
- **PR target (old):** `background: var(--muted-strong); color: var(--text-strong)`
- **Current main:** `background: var(--accent); color: var(--accent-foreground)`

The button now uses the `--accent` / `--accent-foreground` color pair, which is designed for sufficient contrast. The PR's fix (hardcoding `#fff` against `--muted-strong`) no longer applies to the current code.

**Action taken:** None. The PR fix is obsolete as written. Cannot auto-resolve because:
1. The button's background color changed, making the original fix inapplicable.
2. If the new `var(--accent-foreground)` still has a contrast problem in light theme, it needs a fresh analysis and different fix.

**Needs human attention:**
- Verify whether the new `var(--accent)` + `var(--accent-foreground)` button meets WCAG AA contrast.
- If yes: close PR #54363 as the issue was fixed differently.
- If no: update PR with a revised fix targeting the new color scheme.

---

### #54730 — fix/subagent-identity-fallback — Open, Rebased

**Contribution:** Two commits by suboss87:
1. `11cc40e01` — `fix(ui): prefer per-agent identity for subagents over global ui.assistant`
   - Adds `isDefaultAgent` logic to `resolveAssistantIdentity()` so subagents use their own configured identity rather than the global `ui.assistant` setting
   - Adds 70 lines of tests in `assistant-identity.test.ts`
2. `bf6f12db3` — `refactor: hoist resolveDefaultAgentId to avoid redundant call`
   - Addresses Greptile review feedback; extracts `defaultAgentId` to avoid calling `resolveDefaultAgentId` twice

**Conflict situation:** The refactor commit (`bf6f12db3`) conflicted because it was based on the fix commit's intermediate state. The fix commit itself applied cleanly to current main.

**Action taken:** Rebased both commits in order (fix first, then refactor) onto current main via cherry-pick. Both applied cleanly in sequence.
- Old branch tip: `bf6f12db328ec33549563463e04b9ee1cb38fee3`
- New branch tip: `8fb20f890...` (two clean cherry-picks on main)
- Force-pushed to `origin/fix/subagent-identity-fallback`

**Needs human attention:** Cannot post rebase comment to PR (no GitHub access). Maintainer should note rebase and re-run CI.

---

## Actions Taken Summary

1. **PR #45584** — Rebased `feat/cron-fresh-session-option` onto current `main`. Force-pushed to `origin/feat/cron-fresh-session-option`.
2. **PR #54730** — Rebased `fix/subagent-identity-fallback` (2 commits) onto current `main`. Force-pushed to `origin/fix/subagent-identity-fallback`.

## PRs Requiring Human Attention

| PR | Reason |
|----|--------|
| openclaw/openclaw#45584 | Needs CI re-run after rebase; maintainer should note rebase in PR |
| openclaw/openclaw#54363 | Conflict is structural (button redesigned in main); needs human decision on whether fix is still needed |
| openclaw/openclaw#54730 | Needs CI re-run after rebase; maintainer should note rebase in PR |

## Blocker: No GitHub API Access

Cannot perform the following without `gh` CLI or `mcp__github__*` tools:
- Check actual PR open/closed/merged status via GitHub API
- Read review comments or CI check results
- Post rebase notifications to PRs
- Resolve bot review conversations

PR statuses above are inferred from git history analysis only.
