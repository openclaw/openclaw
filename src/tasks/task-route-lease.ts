// Generic task-route lease module.
//
// Background-task completion delivery needs a stable route from the time a
// detached task is created until its completion announcer actually fires.
// The cron / subagent / ACP / codex / media paths each resolve their own
// outbound origin, but the originator session entry can be evicted, the
// shared main session bucket can be retargeted by another conversation, and
// the explicit delivery config may not survive all the way to the announce
// step (see #92460 for the cron symptom; #92076/#93323 for the subagent
// symptom).
//
// This module owns a SQLite-backed lease row keyed by (run_id, runtime,
// scope_kind, owner_key, child_session_key) — the same scope tuple the
// task registry uses to distinguish shared-runId task records (see
// `R3 (separate from generic session identity)` in the design notes).
// A raw runId is not unique on main today, so the lease key mirrors the
// task-registry scope to keep one task from replacing or exposing another
// task's requester origin when their runIds collide. Callers that do not
// yet pass scope fields fall back to the "detached/owner/<empty>" default
// tuple; future caller paths should pass the matching task-registry scope.
// Acquire happens on task start, settle happens on delivery status
// transitions to terminal, expiry GC handles stuck leases.
//
// Public API:
//   acquireTaskRouteLease: idempotent — re-acquire on the same
//     (runId, scope) tuple replaces the existing row with the new TTL.
//   getActiveTaskRouteLease: returns the lease if status='active' and not
//     expired; otherwise undefined. Used by delivery-target resolvers as
//     a session-identity fallback.
//   settleTaskRouteLease: marks the lease as retired with a final status
//     (delivered / failed / session_queued). Idempotent.
//   extendTaskRouteLease: bumps expiresAt for long-running tasks.
//   expireStaleTaskRouteLeases: TTL GC for leases that never received a
//     settle call (caller crashed, delivery silently lost, etc).
//
// All functions are best-effort — they log on failure but never throw, so
// they can be wired into hot lifecycle paths without risk of breaking the
// caller.

import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { parseDeliveryContextJson } from "./task-registry.sqlite.shared.js";

const log = createSubsystemLogger("tasks/route-lease");

type TaskRouteLeasesTable = OpenClawStateKyselyDatabase["task_route_leases"];
type TaskRouteLeaseRow = Selectable<TaskRouteLeasesTable>;
type TaskRouteLeaseInsert = Insertable<TaskRouteLeasesTable>;
type TaskRouteLeaseDatabase = Pick<OpenClawStateKyselyDatabase, "task_route_leases">;

/** Status of a task route lease. */
export type TaskRouteLeaseStatus = "active" | "settling" | "settled" | "retired" | "expired";

/**
 * Scope tuple that disambiguates lease rows sharing the same runId. Mirrors
 * the corresponding `TaskRecord` fields so a lease acquired for one scope
 * cannot be replaced or exposed by another scope's lease on the same runId.
 * Empty strings are the schema default; callers that already know the
 * task-registry scope should pass it explicitly so collision is impossible.
 */
export type TaskRouteLeaseScope = {
  runtime?: string;
  scopeKind?: string;
  ownerKey?: string;
  childSessionKey?: string;
};

/** Default scope for caller paths that do not yet pass scope fields.
 *  Matches the schema DEFAULT values; picking "detached"/"owner"/"" keeps
 *  raw-runId-keyed callers behaving like single-tenant callers until they
 *  opt in to the scoped lookup. */
const DEFAULT_LEASE_SCOPE: Required<TaskRouteLeaseScope> = {
  runtime: "detached",
  scopeKind: "owner",
  ownerKey: "",
  childSessionKey: "",
};

function normalizeScope(scope: TaskRouteLeaseScope | undefined): Required<TaskRouteLeaseScope> {
  return {
    runtime: scope?.runtime ?? DEFAULT_LEASE_SCOPE.runtime,
    scopeKind: scope?.scopeKind ?? DEFAULT_LEASE_SCOPE.scopeKind,
    ownerKey: scope?.ownerKey ?? DEFAULT_LEASE_SCOPE.ownerKey,
    childSessionKey: scope?.childSessionKey ?? DEFAULT_LEASE_SCOPE.childSessionKey,
  };
}

/** Public shape of a task route lease. */
export type TaskRouteLease = {
  runId: string;
  taskId: string;
  scope: TaskRouteLeaseScope;
  requesterOrigin?: DeliveryContext;
  acquiredAt: number;
  expiresAt: number;
  settledAt?: number;
  status: TaskRouteLeaseStatus;
};

/** Parameters for acquireTaskRouteLease. */
export type AcquireTaskRouteLeaseParams = {
  runId: string;
  taskId: string;
  /** Optional scope tuple. When provided, the lease is keyed by
   *  (runId, scope) instead of runId alone, so callers that already know
   *  the task-registry scope can avoid cross-scope collisions. */
  scope?: TaskRouteLeaseScope;
  requesterOrigin?: DeliveryContext;
  /** TTL in ms; defaults to 52h (matches the cron task max window). */
  ttlMs?: number;
  /** Now override for tests. */
  now?: number;
  /**
   * Process env for callers that opened a temp-dir shared state DB via
   * `openOpenClawStateDatabase({ env })`. Without this, the internal
   * write transaction would fall back to process.env and write to a
   * different DB than the caller intended.
   */
  env?: NodeJS.ProcessEnv;
};

/** Default TTL: 52h. Covers a 48h agent run window plus a 4h buffer for
 *  suspended completion delivery (the 2-6h recovery window the prior
 *  delivery-lease-store experiments used). */
const DEFAULT_LEASE_TTL_MS = 52 * 60 * 60 * 1000;

/** Default settle statuses — all terminal delivery states retire the lease. */
const SETTLE_STATUSES: ReadonlySet<string> = new Set(["delivered", "failed", "session_queued"]);

function getTaskRouteLeaseKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TaskRouteLeaseDatabase>(db);
}

function normalizeLeaseRow(row: TaskRouteLeaseRow): TaskRouteLease {
  const lease: TaskRouteLease = {
    runId: row.run_id,
    taskId: row.task_id,
    scope: {
      runtime: row.runtime,
      scopeKind: row.scope_kind,
      ownerKey: row.owner_key,
      childSessionKey: row.child_session_key,
    },
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    status: row.status as TaskRouteLeaseStatus,
  };
  const origin = parseDeliveryContextJson(row.requester_origin_json);
  if (origin) {
    lease.requesterOrigin = origin;
  }
  if (row.settled_at != null) {
    lease.settledAt = row.settled_at;
  }
  return lease;
}

function buildInsert(params: AcquireTaskRouteLeaseParams, now: number): TaskRouteLeaseInsert {
  const origin = normalizeDeliveryContext(params.requesterOrigin);
  const ttlMs = params.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const scope = normalizeScope(params.scope);
  return {
    run_id: params.runId,
    runtime: scope.runtime,
    scope_kind: scope.scopeKind,
    owner_key: scope.ownerKey,
    child_session_key: scope.childSessionKey,
    task_id: params.taskId,
    requester_origin_json: origin ? JSON.stringify(origin) : "",
    acquired_at: now,
    expires_at: now + ttlMs,
    status: "active",
  };
}

/**
 * Acquire (or re-acquire) a task route lease. Best-effort: never throws.
 * Returns the persisted lease on success, undefined on failure.
 *
 * Idempotent on the (runId, scope) tuple: re-acquiring with the same scope
 * replaces the existing row's TTL + status + origin and clears any stale
 * `settled_at`. Acquiring with the same runId but a different scope is a
 * fresh insert (no collision, no overwrite).
 */
export function acquireTaskRouteLease(
  params: AcquireTaskRouteLeaseParams,
): TaskRouteLease | undefined {
  const now = params.now ?? Date.now();
  const insert = buildInsert(params, now);
  const scope = normalizeScope(params.scope);
  const txOptions = params.env ? { env: params.env } : undefined;
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("task_route_leases")
          .values(insert)
          .onConflict((conflict) =>
            conflict
              .columns(["run_id", "runtime", "scope_kind", "owner_key", "child_session_key"])
              .doUpdateSet({
                task_id: (eb) => eb.ref("excluded.task_id"),
                requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
                acquired_at: (eb) => eb.ref("excluded.acquired_at"),
                expires_at: (eb) => eb.ref("excluded.expires_at"),
                status: (eb) => eb.ref("excluded.status"),
                // Re-acquire is a fresh lifecycle: any stale `settled_at` from
                // a prior terminal transition must be cleared, otherwise
                // getActiveTaskRouteLease would return a lease whose
                // `.settledAt` field still reflects the old terminal state.
                settled_at: null,
              }),
          ),
      );
    }, txOptions);
    return getActiveTaskRouteLease(params.runId, { scope: params.scope, now, env: params.env });
  } catch (error) {
    log.warn("acquireTaskRouteLease failed", {
      runId: params.runId,
      taskId: params.taskId,
      runtime: scope.runtime,
      scopeKind: scope.scopeKind,
      error,
    });
    return undefined;
  }
}

/**
 * Return the active lease for the given (runId, scope) tuple, or undefined
 * if the lease is missing, expired, or in any non-active status.
 *
 * An "active" lease is one whose status is 'active' AND expiresAt > now.
 * 'settling' is treated as inactive because the delivery path is mid-flight
 * and callers should not pick up a lease that another caller is settling.
 *
 * Callers that already know the task-registry scope should pass `scope` so
 * the lookup is exact; without scope, the default "detached/owner/<empty>"
 * tuple is used, which is safe for single-tenant caller paths but does not
 * protect against cross-scope collisions when multiple scopes share a runId.
 */
export function getActiveTaskRouteLease(
  runId: string,
  options: { scope?: TaskRouteLeaseScope; now?: number; env?: NodeJS.ProcessEnv } = {},
): TaskRouteLease | undefined {
  const now = options.now ?? Date.now();
  const scope = normalizeScope(options.scope);
  try {
    const { db } = openOpenClawStateDatabase(options.env ? { env: options.env } : {});
    const query = getTaskRouteLeaseKysely(db)
      .selectFrom("task_route_leases")
      .selectAll()
      .where("run_id", "=", runId)
      .where("runtime", "=", scope.runtime)
      .where("scope_kind", "=", scope.scopeKind)
      .where("owner_key", "=", scope.ownerKey)
      .where("child_session_key", "=", scope.childSessionKey)
      .where("status", "=", "active")
      .where("expires_at", ">", now)
      .limit(1);
    const rows = executeSqliteQuerySync(db, query).rows;
    const first = rows[0];
    return first ? normalizeLeaseRow(first) : undefined;
  } catch (error) {
    log.warn("getActiveTaskRouteLease failed", { runId, scope, error });
    return undefined;
  }
}

/**
 * Settle a task route lease by transitioning it to a terminal status
 * ('settled' or 'retired'). Idempotent — repeated calls on the same lease
 * are no-ops once the lease is already in a terminal status.
 *
 * Returns true if the lease was newly settled in this call, false if it
 * was already terminal (or missing). Best-effort: never throws.
 *
 * The scope tuple is required when a caller distinguishes multiple leases
 * on the same runId; pass it explicitly so the settle targets the same
 * row that was acquired.
 */
export function settleTaskRouteLease(
  runId: string,
  finalStatus: "settled" | "retired",
  options: { scope?: TaskRouteLeaseScope; now?: number; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const now = options.now ?? Date.now();
  const scope = normalizeScope(options.scope);
  const txOptions = options.env ? { env: options.env } : undefined;
  try {
    let newlySettled = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("task_route_leases")
          .set({ status: finalStatus, settled_at: now })
          .where("run_id", "=", runId)
          .where("runtime", "=", scope.runtime)
          .where("scope_kind", "=", scope.scopeKind)
          .where("owner_key", "=", scope.ownerKey)
          .where("child_session_key", "=", scope.childSessionKey)
          .where("status", "=", "active"),
      );
      newlySettled = Number(result.numAffectedRows ?? 0n) > 0;
    }, txOptions);
    return newlySettled;
  } catch (error) {
    log.warn("settleTaskRouteLease failed", { runId, finalStatus, scope, error });
    return false;
  }
}

/** Final delivery status → lease retirement status. */
export function mapDeliveryStatusToLeaseRetirement(
  deliveryStatus: string,
): "settled" | "retired" | null {
  if (!SETTLE_STATUSES.has(deliveryStatus)) {
    return null;
  }
  // 'delivered' / 'session_queued' = successful settle.
  // 'failed' = lease is retired without successful delivery.
  return deliveryStatus === "failed" ? "retired" : "settled";
}

/**
 * Update the captured `requesterOrigin` of an active lease. Idempotent —
 * updating an already-terminal lease is a no-op. Best-effort: never throws.
 *
 * Used after the delivery-target resolver has produced a concrete
 * channel/to/account/thread (see #92460 P1 #2): the lease captured at
 * `tryCreateCronTaskRun` time may have only the cron job's own
 * `delivery.channel` and no `to`; once the resolver has produced a routable
 * target, the lease is updated so the completion-time resolver can recover
 * the same target even when higher-precedence session sources have been
 * evicted or retargeted in the meantime.
 *
 * Pass `scope` to target a specific (runId, scope) row when the runId is
 * shared across scopes; without scope the default tuple is used.
 */
export function updateTaskRouteLease(
  runId: string,
  requesterOrigin: DeliveryContext | undefined,
  options: { scope?: TaskRouteLeaseScope; now?: number; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const origin = normalizeDeliveryContext(requesterOrigin);
  const scope = normalizeScope(options.scope);
  const txOptions = options.env ? { env: options.env } : undefined;
  try {
    let updated = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      // Only update active leases. The active lookup filter (`status='active'`
      // AND `expires_at > now`) is mirrored here so a lease that already
      // settled or expired is not silently re-armed with a new origin.
      const now = options.now ?? Date.now();
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("task_route_leases")
          .set({
            requester_origin_json: origin ? JSON.stringify(origin) : "",
          })
          .where("run_id", "=", runId)
          .where("runtime", "=", scope.runtime)
          .where("scope_kind", "=", scope.scopeKind)
          .where("owner_key", "=", scope.ownerKey)
          .where("child_session_key", "=", scope.childSessionKey)
          .where("status", "=", "active")
          .where("expires_at", ">", now),
      );
      updated = Number(result.numAffectedRows ?? 0n) > 0;
    }, txOptions);
    return updated;
  } catch (error) {
    log.warn("updateTaskRouteLease failed", { runId, scope, error });
    return false;
  }
}

/**
 * Extend the TTL of an active lease. Idempotent — extending an already-
 * terminal lease is a no-op. Best-effort: never throws.
 *
 * Pass `scope` to target a specific (runId, scope) row when the runId is
 * shared across scopes; without scope the default tuple is used.
 */
export function extendTaskRouteLease(
  runId: string,
  ttlMs: number,
  options: { scope?: TaskRouteLeaseScope; now?: number; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const now = options.now ?? Date.now();
  const scope = normalizeScope(options.scope);
  const txOptions = options.env ? { env: options.env } : undefined;
  try {
    let extended = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("task_route_leases")
          .set({ expires_at: now + ttlMs })
          .where("run_id", "=", runId)
          .where("runtime", "=", scope.runtime)
          .where("scope_kind", "=", scope.scopeKind)
          .where("owner_key", "=", scope.ownerKey)
          .where("child_session_key", "=", scope.childSessionKey)
          .where("status", "=", "active"),
      );
      extended = Number(result.numAffectedRows ?? 0n) > 0;
    }, txOptions);
    return extended;
  } catch (error) {
    log.warn("extendTaskRouteLease failed", { runId, ttlMs, scope, error });
    return false;
  }
}

/**
 * Mark all active leases whose expiresAt is <= now as 'expired'. Returns
 * the count of leases expired in this call. Best-effort: never throws.
 *
 * Intended to run periodically (e.g. on gateway startup and via a low-
 * frequency timer) so that leases from crashed callers do not accumulate
 * in the table indefinitely.
 */
export function expireStaleTaskRouteLeases(
  options: { now?: number; env?: NodeJS.ProcessEnv } = {},
): number {
  const now = options.now ?? Date.now();
  const txOptions = options.env ? { env: options.env } : undefined;
  try {
    let expired = 0;
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("task_route_leases")
          .set({ status: "expired", settled_at: now })
          .where("status", "=", "active")
          .where("expires_at", "<=", now),
      );
      expired = Number(result.numAffectedRows ?? 0n);
    }, txOptions);
    return expired;
  } catch (error) {
    log.warn("expireStaleTaskRouteLeases failed", { error });
    return 0;
  }
}

/**
 * Delete every route lease row whose `task_id` matches. Used by the task
 * registry store delete path so settled/expired/orphaned leases do not
 * accumulate after ordinary task cleanup.
 *
 * The lease module owns its own SQL; this function is the
 * owner-bounded entry point that lets `task-registry.store.sqlite.ts`
 * clean up leases inside the same write transaction as `task_runs` +
 * `task_delivery_state` deletes. Caller owns the transaction — do not
 * call this from a non-transactional context if you also need atomicity
 * with other row deletes.
 *
 * Best-effort: never throws, returns the row count deleted (0 on
 * failure or no matches).
 */
export function deleteTaskRouteLeasesByTaskIdInDb(db: DatabaseSync, taskId: string): number {
  try {
    const kysely = getTaskRouteLeaseKysely(db);
    const result = executeSqliteQuerySync(
      db,
      kysely.deleteFrom("task_route_leases").where("task_id", "=", taskId),
    );
    return Number(result.numAffectedRows ?? 0n);
  } catch (error) {
    log.warn("deleteTaskRouteLeasesByTaskIdInDb failed", { taskId, error });
    return 0;
  }
}

/** Test helper: drop every lease row. Used only by the lifecycle test reset
 *  path; not exported on the production runtime surface. */
export function resetTaskRouteLeasesForTests(options: { env?: NodeJS.ProcessEnv } = {}): void {
  try {
    const txOptions = options.env ? { env: options.env } : undefined;
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      executeSqliteQuerySync(db, kysely.deleteFrom("task_route_leases"));
    }, txOptions);
  } catch {
    // Test-only path; failure is non-fatal because tests create a fresh DB.
  }
}
