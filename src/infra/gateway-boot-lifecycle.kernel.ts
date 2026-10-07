import type { DatabaseSync } from "node:sqlite";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "./startup-maintenance-required.js";

type GatewayBootLifecycleDatabase = Pick<DB, "gateway_boot_lifecycle">;
const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;
const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
export const GATEWAY_CRASH_LOOP_BREAKER_REASON = "gateway.crash_loop_breaker";
export const GATEWAY_CRASH_LOOP_RECOVERED_REASON = "gateway.crash_loop_recovered";
export const maintenanceStartupReasons = [
  GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON,
  "gateway.agent_media_migration_required",
];

export function buildGatewayCrashLoopBreakerDecision(params: {
  uncleanBoots: number;
  latestBreakerStartedAtMs?: number | null;
  latestRecoveryStartedAtMs?: number | null;
  latestUncleanAtMs?: number | null;
}) {
  const tripped = params.uncleanBoots >= GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD;
  const hasUnrecoveredBreakerMarker =
    typeof params.latestBreakerStartedAtMs === "number" &&
    (typeof params.latestRecoveryStartedAtMs !== "number" ||
      params.latestRecoveryStartedAtMs < params.latestBreakerStartedAtMs);
  // Recovery waits until the unclean window drains. A clean safe-mode boot
  // proves the control plane works, not that suppressed channel autostart is safe.
  return {
    tripped,
    // The persisted trip marker latches safe mode. Counting the current open
    // boot alone must not trip an otherwise healthy process after startup.
    recoveryPausedUntilMs:
      hasUnrecoveredBreakerMarker && params.latestUncleanAtMs != null
        ? params.latestUncleanAtMs + GATEWAY_BOOT_LOOP_WINDOW_MS + 1
        : undefined,
    uncleanBoots: params.uncleanBoots,
    windowMs: GATEWAY_BOOT_LOOP_WINDOW_MS,
    shouldWriteStabilityBundle: tripped && !hasUnrecoveredBreakerMarker,
    recovered: !tripped && hasUnrecoveredBreakerMarker,
  };
}

export function inspectGatewayCrashLoopBreakerInDatabase(db: DatabaseSync, nowMs: number) {
  const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
  const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;
  // Unclean means startup_failed by completion time, or an open boot row
  // whose process disappeared. forced_stop is operator shutdown pressure,
  // not a startup crash-loop signal.
  const uncleanRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("gateway_boot_lifecycle")
      .select((eb) => [
        eb.fn.countAll<number>().as("count"),
        eb.fn
          .max<number>(eb.fn.coalesce("completed_at_ms", "started_at_ms"))
          .as("latestUncleanAtMs"),
      ])
      .where((eb) =>
        eb.or([
          eb("startup_reason", "is", null),
          eb("startup_reason", "not in", maintenanceStartupReasons),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb.and([eb("completed_at_ms", "is", null), eb("started_at_ms", ">=", windowStartMs)]),
          eb.and([
            eb("outcome", "=", "startup_failed"),
            eb("completed_at_ms", ">=", windowStartMs),
          ]),
        ]),
      ),
  );
  const latestBreaker = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("gateway_boot_lifecycle")
      .select("started_at_ms as startedAtMs")
      .where("startup_reason", "=", GATEWAY_CRASH_LOOP_BREAKER_REASON)
      .orderBy("started_at_ms", "desc")
      .limit(1),
  );
  const latestRecovery = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("gateway_boot_lifecycle")
      .select("started_at_ms as startedAtMs")
      .where("startup_reason", "=", GATEWAY_CRASH_LOOP_RECOVERED_REASON)
      .orderBy("started_at_ms", "desc")
      .limit(1),
  );
  return buildGatewayCrashLoopBreakerDecision({
    uncleanBoots: uncleanRow?.count ?? 0,
    latestUncleanAtMs: uncleanRow?.latestUncleanAtMs,
    latestBreakerStartedAtMs: latestBreaker?.startedAtMs,
    latestRecoveryStartedAtMs: latestRecovery?.startedAtMs,
  });
}

export const gatewayBootReadOperations = {
  "gatewayBoot.breaker": (nowMs: number, db) => ({
    type: "gatewayBoot.breaker" as const,
    decision: runSqliteDeferredTransactionSync(db, () =>
      inspectGatewayCrashLoopBreakerInDatabase(db, nowMs),
    ),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
