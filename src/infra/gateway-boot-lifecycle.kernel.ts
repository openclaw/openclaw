import type { DB } from "../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { GATEWAY_STARTUP_MAINTENANCE_REQUIRED_REASON } from "./startup-maintenance-required.js";
import { TAILSCALE_BACKEND_AUTH_REQUIRED_REASON } from "./tailscale-backend-auth-required-error.js";
import { TAILSCALE_BACKEND_STOPPED_REASON } from "./tailscale-backend-stopped-error.js";

type GatewayBootLifecycleDatabase = Pick<DB, "gateway_boot_lifecycle">;
const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;
const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
export const GATEWAY_SIGNAL_REPEAT_WINDOW_MS = 5 * 60_000;
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

export function inspectGatewayCrashLoopBreakerInDatabase(db: EngineConnection, nowMs: number) {
  const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
  const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;
  // Unclean means startup_failed by completion time, or an open boot row
  // whose process disappeared. A completed stopped-daemon refusal happens
  // before channels start; unfinished boots still count. forced_stop is
  // operator shutdown pressure, not a startup crash-loop signal.
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("gateway_boot_lifecycle")
      .select((eb) => [
        eb.fn.countAll<number>().as("count"),
        eb.fn
          .max<number>(eb.fn.coalesce("completed_at_ms", "started_at_ms"))
          .as("latestUncleanAtMs"),
        eb
          .selectFrom("gateway_boot_lifecycle")
          .select("started_at_ms")
          .where("startup_reason", "=", GATEWAY_CRASH_LOOP_BREAKER_REASON)
          .orderBy("started_at_ms", "desc")
          .limit(1)
          .as("latestBreakerStartedAtMs"),
        eb
          .selectFrom("gateway_boot_lifecycle")
          .select("started_at_ms")
          .where("startup_reason", "=", GATEWAY_CRASH_LOOP_RECOVERED_REASON)
          .orderBy("started_at_ms", "desc")
          .limit(1)
          .as("latestRecoveryStartedAtMs"),
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
            eb.or([
              eb("startup_reason", "is", null),
              eb("startup_reason", "!=", TAILSCALE_BACKEND_STOPPED_REASON),
            ]),
            eb("completed_at_ms", ">=", windowStartMs),
            eb.or([
              eb("startup_reason", "is", null),
              eb("startup_reason", "!=", TAILSCALE_BACKEND_AUTH_REQUIRED_REASON),
            ]),
          ]),
        ]),
      ),
  );
  return buildGatewayCrashLoopBreakerDecision({
    uncleanBoots: row?.count ?? 0,
    latestUncleanAtMs: row?.latestUncleanAtMs,
    latestBreakerStartedAtMs: row?.latestBreakerStartedAtMs,
    latestRecoveryStartedAtMs: row?.latestRecoveryStartedAtMs,
  });
}

function readGatewayLastShutdownInDatabase(db: EngineConnection) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db)
      .selectFrom("gateway_boot_lifecycle")
      .select(["reason", "completed_at_ms as completedAtMs"])
      .where("outcome", "in", ["clean_stop", "planned_restart", "forced_stop"])
      .where("completed_at_ms", "is not", null)
      .orderBy("completed_at_ms", "desc")
      .limit(1),
  );
  return row?.completedAtMs == null ? undefined : { ...row, completedAtMs: row.completedAtMs };
}

export const gatewayBootReadOperations = {
  "gatewayBoot.lastShutdown": (_input: undefined, db) => ({
    type: "gatewayBoot.lastShutdown" as const,
    shutdown: readGatewayLastShutdownInDatabase(db),
  }),
  "gatewayBoot.breaker": (nowMs: number, db) => ({
    type: "gatewayBoot.breaker" as const,
    decision: inspectGatewayCrashLoopBreakerInDatabase(db, nowMs),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;
