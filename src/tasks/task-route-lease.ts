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
// This module owns a SQLite-backed lease row keyed by detached run id (NOT
// task id — a single task can produce multiple runs over time, each owning
// its own route lease, see `R3 (separate from generic session identity)` in
// the design notes). Acquire happens on task start, settle happens on
// delivery status transitions to terminal, expiry GC handles stuck leases.
//
// Public API:
//   acquireTaskRouteLease: idempotent — re-acquire on the same runId
//     replaces the existing row with the new TTL.
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

/** Public shape of a task route lease. */
export type TaskRouteLease = {
  runId: string;
  taskId: string;
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
  requesterOrigin?: DeliveryContext;
  /** TTL in ms; defaults to 52h (matches the cron task max window). */
  ttlMs?: number;
  /** Now override for tests. */
  now?: number;
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
  return {
    run_id: params.runId,
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
 */
export function acquireTaskRouteLease(
  params: AcquireTaskRouteLeaseParams,
): TaskRouteLease | undefined {
  const now = params.now ?? Date.now();
  const insert = buildInsert(params, now);
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("task_route_leases")
          .values(insert)
          .onConflict((conflict) =>
            conflict.column("run_id").doUpdateSet({
              task_id: (eb) => eb.ref("excluded.task_id"),
              requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
              acquired_at: (eb) => eb.ref("excluded.acquired_at"),
              expires_at: (eb) => eb.ref("excluded.expires_at"),
              status: (eb) => eb.ref("excluded.status"),
            }),
          ),
      );
    });
    return getActiveTaskRouteLease(params.runId, { now });
  } catch (error) {
    log.warn("acquireTaskRouteLease failed", {
      runId: params.runId,
      taskId: params.taskId,
      error,
    });
    return undefined;
  }
}

/**
 * Return the active lease for the given runId, or undefined if the lease
 * is missing, expired, or in any non-active status.
 *
 * An "active" lease is one whose status is 'active' AND expiresAt > now.
 * 'settling' is treated as inactive because the delivery path is mid-flight
 * and callers should not pick up a lease that another caller is settling.
 */
export function getActiveTaskRouteLease(
  runId: string,
  options: { now?: number } = {},
): TaskRouteLease | undefined {
  const now = options.now ?? Date.now();
  try {
    const { db } = openOpenClawStateDatabase();
    const query = getTaskRouteLeaseKysely(db)
      .selectFrom("task_route_leases")
      .selectAll()
      .where("run_id", "=", runId)
      .where("status", "=", "active")
      .where("expires_at", ">", now)
      .limit(1);
    const rows = executeSqliteQuerySync(db, query).rows;
    const first = rows[0];
    return first ? normalizeLeaseRow(first) : undefined;
  } catch (error) {
    log.warn("getActiveTaskRouteLease failed", { runId, error });
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
 */
export function settleTaskRouteLease(
  runId: string,
  finalStatus: "settled" | "retired",
  options: { now?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
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
          .where("status", "=", "active"),
      );
      newlySettled = Number(result.numAffectedRows ?? 0n) > 0;
    });
    return newlySettled;
  } catch (error) {
    log.warn("settleTaskRouteLease failed", { runId, finalStatus, error });
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
 */
export function updateTaskRouteLease(
  runId: string,
  requesterOrigin: DeliveryContext | undefined,
  options: { now?: number } = {},
): boolean {
  const origin = normalizeDeliveryContext(requesterOrigin);
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
          .where("status", "=", "active")
          .where("expires_at", ">", now),
      );
      updated = Number(result.numAffectedRows ?? 0n) > 0;
    });
    return updated;
  } catch (error) {
    log.warn("updateTaskRouteLease failed", { runId, error });
    return false;
  }
}

/**
 * Extend the TTL of an active lease. Idempotent — extending an already-
 * terminal lease is a no-op. Best-effort: never throws.
 */
export function extendTaskRouteLease(
  runId: string,
  ttlMs: number,
  options: { now?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
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
          .where("status", "=", "active"),
      );
      extended = Number(result.numAffectedRows ?? 0n) > 0;
    });
    return extended;
  } catch (error) {
    log.warn("extendTaskRouteLease failed", { runId, ttlMs, error });
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
export function expireStaleTaskRouteLeases(options: { now?: number } = {}): number {
  const now = options.now ?? Date.now();
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
    });
    return expired;
  } catch (error) {
    log.warn("expireStaleTaskRouteLeases failed", { error });
    return 0;
  }
}

/** Test helper: drop every lease row. Used only by the lifecycle test reset
 *  path; not exported on the production runtime surface. */
export function resetTaskRouteLeasesForTests(): void {
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getTaskRouteLeaseKysely(db);
      executeSqliteQuerySync(db, kysely.deleteFrom("task_route_leases"));
    });
  } catch {
    // Test-only path; failure is non-fatal because tests create a fresh DB.
  }
}
