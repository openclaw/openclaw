# PR Fix Sprint Tasks (Claude Code)

## Global Rules (All Workers)

- [ ] Stay on assigned PR branch only
- [ ] Rebase/merge latest `origin/main`
- [ ] Fix only failing CI checks listed for assigned PR
- [ ] Run validation before and after edits
- [ ] Commit with clear message and push branch
- [ ] Post final report with exact commands and results

---

## PR #13032 — feat(session-end-hooks)

Branch: `feat/session-end-hooks`
Risk: Medium

### Scope

- Allowed:
  - `src/auto-reply/reply/session.ts`
  - `src/auto-reply/reply/commands-compact.ts`
  - Any directly required type definition files for `SessionEntry`
- Out of scope:
  - unrelated feature changes, refactors, dependency changes

### Known failing check

- `Property 'messageCount' does not exist on type 'SessionEntry'`

### Tasks

- [ ] Reproduce failing check locally
- [ ] Resolve `SessionEntry.messageCount` mismatch (type-safe)
- [ ] Ensure no behavior regressions in auto-reply flow
- [ ] Run full required check command
- [ ] Commit + push

### Validation

- `pnpm install`
- `pnpm -r build` (if required by repo convention)
- `pnpm check` (or equivalent CI check command)

---

## PR #13042 — feat(guard-model)

Branch: `feat/guard-model`
Risk: Medium

### Scope

- Allowed:
  - `src/security/guard-model.ts`
  - `src/config/zod-schema.agent-defaults.ts`
  - directly-related exported symbol files only
- Out of scope:
  - broad security framework changes

### Known failing check

- `Module '../logger.js' has no exported member 'Logger'`
- `Module './zod-schema.providers-core.js' has no exported member 'GuardModelConfigSchema'`

### Tasks

- [ ] Reproduce failing check locally
- [ ] Fix logger import/export mismatch cleanly
- [ ] Fix guard config schema import/export mismatch cleanly
- [ ] Run full required check command
- [ ] Commit + push

### Validation

- `pnpm install`
- `pnpm check`

---

## PR #13014 — feat(systemd-watchdog)

Branch: `feat/systemd-watchdog`
Risk: Medium

### Scope

- Allowed:
  - `src/infra/systemd-notify.ts`
  - docs files only if needed to satisfy `check-docs`
- Out of scope:
  - unrelated infra cleanup

### Known failing checks

- `No overload matches this call` in `src/infra/systemd-notify.ts`
- `check-docs` failing in CI

### Tasks

- [ ] Reproduce `check` and `check-docs` locally
- [ ] Fix TypeScript overload usage in systemd notify implementation
- [ ] Fix docs check failures (links/format/frontmatter/etc.)
- [ ] Run full required check command(s)
- [ ] Commit + push

### Validation

- `pnpm install`
- `pnpm check`
- docs check command used by CI workflow

---

## PR #20844 — feat(task-queue-swarm-trust)

Branch: `feat/task-queue-swarm-trust`
Risk: Medium

### Scope

- Allowed:
  - `ui/src/ui/views/task-queue.ts`
  - `ui/src/ui/views/swarm.ts`
  - `ui/src/ui/format.ts` (or correct formatting utility module)
  - `src/gateway/server-methods/trust.ts`
- Out of scope:
  - broader dashboard redesign or trust API redesign

### Known failing check

- `formatAgo` import not exported from `../format.ts`
- implicit `any` return type in swarm view functions
- `NOT_FOUND` missing on trust error enum/object

### Tasks

- [ ] Reproduce failing check locally
- [ ] Resolve `formatAgo` import/export mismatch
- [ ] Add explicit return types where required in swarm/task-queue views
- [ ] Resolve trust error enum/object mismatch
- [ ] Run full required check command
- [ ] Commit + push

### Validation

- `pnpm install`
- `pnpm check`

---

## Completion Criteria

- [ ] All 4 PR branches pushed with fixes
- [ ] `gh pr checks <PR>` shows no failing checks
- [ ] No scope creep or unrelated file churn
- [ ] Final summary posted with per-PR status and links
