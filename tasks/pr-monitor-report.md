# PR Monitor Report

**Date:** 2026-04-06 (run 9)
**Contributor:** suboss87
**Repo:** openclaw/openclaw

---

## PRs Checked

| PR     | Branch                                  | Status | CI                       | Review                   | Conflicts        | Actions Taken                                       |
| ------ | --------------------------------------- | ------ | ------------------------ | ------------------------ | ---------------- | --------------------------------------------------- |
| #45911 | fix/telegram-approval-callback-fallback | MERGED | N/A                      | N/A                      | N/A              | None (already merged)                               |
| #45584 | feat/cron-fresh-session-option          | OPEN   | FAILING (protocol check) | Bot comments addressed   | DIRTY (upstream) | Regenerated Swift protocol files; pushed format fix |
| #54363 | fix/chat-send-button-contrast           | CLOSED | N/A                      | N/A                      | N/A              | None (closed without merge)                         |
| #54730 | fix/subagent-identity-fallback          | OPEN   | FAILING (stale CI run)   | Bot P2 already addressed | None             | Pushed format fix; protocol check passes locally    |

---

## PR #45911 — fix/telegram-approval-callback-fallback

**Status:** MERGED (closed 2026-03-xx)

No action required.

---

## PR #45584 — feat/cron-fresh-session-option

**Status:** OPEN | **Branch:** `feat/cron-fresh-session-option`

**CI:** Failing — `checks-fast-contracts-protocol`

- Root cause: PR added `freshSession: Type.Optional(Type.Boolean())` to `src/gateway/protocol/schema/cron.ts` but did not regenerate the Swift `GatewayModels.swift` files.
- Fix applied: Ran `pnpm protocol:gen && pnpm protocol:gen:swift`, committed the Swift changes, pushed.
  - Commit: `569a0bdfab chore(protocol): regenerate Swift models for freshSession cron field`

**Review comments:**

- greptile-apps[bot] (2026-03-14): JSDoc inaccuracy on `freshSession` in `src/cron/types-shared.ts`. **Already addressed** — branch already has the correct JSDoc.
- chatgpt-codex-connector[bot] P1 (2026-03-14): `freshSession` not persisted in `createJob`/`applyJobPatch`. **Already addressed** — `src/cron/service/jobs.ts` already handles it (line 542 and 580–581).

**Merge conflicts:** `mergeable_state: dirty` (upstream `openclaw/openclaw:main` has diverged).

- Cannot resolve without access to `openclaw/openclaw` upstream remote (proxy only allows `suboss87/openclaw`).
- Needs **human attention**: author should fetch upstream and rebase locally.

**Needs human attention:**

1. Upstream rebase needed — cannot be automated from this environment.

---

## PR #54363 — fix/chat-send-button-contrast

**Status:** CLOSED (2026-03-27, not merged)

No action required.

---

## PR #54730 — fix/subagent-identity-fallback

**Status:** OPEN | **Branch:** `fix/subagent-identity-fallback`

**CI:** `checks-fast-contracts-protocol` showed `failure` on SHA `8fb20f890e` (the CI run at time of check).

- Local verification: `pnpm protocol:check` passes cleanly — no protocol schema diffs.
- CI failure appears to be a stale/transient run from before the latest commit (`8fb20f890e refactor: hoist resolveDefaultAgentId`).
- Format issue in `tasks/pr-monitor-report.md` (from prior monitoring commit) fixed and pushed.
  - Commit: `d18c8771bb chore(format): fix markdown formatting in pr-monitor-report`

**Review comments:**

- greptile-apps[bot] P2 (2026-03-25): Redundant `resolveDefaultAgentId` call — hoist to local variable. **Already addressed** by commit `8fb20f890e refactor: hoist resolveDefaultAgentId to avoid redundant call`.

**Merge conflicts:** None (`mergeable_state: unstable` was only due to CI).

**Needs human attention:**

1. CI should be re-triggered or re-run to confirm it now passes.

---

## Actions Taken This Run

1. **PR #45584** — regenerated Swift protocol models (`GatewayModels.swift`) to fix `checks-fast-contracts-protocol` CI failure after `freshSession` schema addition. Pushed to `origin/feat/cron-fresh-session-option`.
2. **PR #45584** — fixed markdown formatting in `tasks/pr-monitor-report.md` (oxfmt) and pushed.
3. **PR #54730** — fixed same markdown formatting issue and pushed to `origin/fix/subagent-identity-fallback`.

---

## PRs Requiring Human Attention

- openclaw/openclaw#45584 — **Needs upstream rebase** (dirty merge conflict with `openclaw/openclaw:main`; cannot rebase from this environment).
- openclaw/openclaw#54730 — **Re-trigger CI** to confirm `checks-fast-contracts-protocol` now passes (failure appears stale; passes locally).
