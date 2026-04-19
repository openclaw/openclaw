# Minions — Durable Job Queue Substrate

Core-owned, extension-agnostic subsystem. All four openclaw task runtimes
(subagent, ACP, CLI, cron) run on this queue.

## Boundary Rules

- Extensions import via `openclaw/plugin-sdk/minions-runtime`, not `src/minions/**`.
- Handlers register deterministically (sorted by name at worker start) for
  prompt-cache stability.
- `MinionStore` uses `node:sqlite` (`DatabaseSync`) with WAL + `BEGIN IMMEDIATE`.
  Single-writer serialization; realistic ceiling is a few hundred claims/sec.
- Status `attached` is non-claimable by design — only the orphan-detection sweep
  transitions rows out of it.
- Status `cancelling` is internal-only — never exposed in the public `TaskStatus`
  union on the TaskRegistry facade.

## Adding a New Handler

1. Create `src/minions/handlers/<name>.handler.ts`.
2. Implement `MinionHandler` — receives `MinionJobContext`, returns result.
3. Implement `isActive(job): boolean` using one of openclaw's liveness checks.
4. Register in `src/minions/handlers/index.ts` (alphabetical order).
5. Add a test in the same directory.

## SQL Dialect Notes (Postgres → SQLite)

- `?` positional placeholders (not `$1, $2`).
- Timestamps are `INTEGER` milliseconds since epoch.
- `BEGIN IMMEDIATE` serializes writers (no `SELECT FOR UPDATE`).
- Cascade-cancel uses 2-step recursive CTE with `UNION` (not `UNION ALL`)
  and depth cap for cycle protection.
- `UPDATE ... RETURNING` via `.all()` for CAS guards.
- SQLite STRICT mode: pass integers to INTEGER columns (`Math.round()`
  any float before binding, e.g. backoff delay with jitter).

## Throughput Constraint

Every claim and complete is a single-writer transaction. Desktop SQLite in
WAL mode sustains a few hundred claims/sec. This is plenty for openclaw's
typical workload. If fan-out exceeds ~1000 concurrent minions, consider
the Postgres engine option (deferred to a future PR).
