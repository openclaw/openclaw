// Persists gateway boot outcomes for supervisor crash-loop decisions.
import { randomUUID } from "node:crypto";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  buildGatewayCrashLoopBreakerDecision,
  inspectGatewayCrashLoopBreakerInDatabase,
  maintenanceStartupReasons,
} from "./gateway-boot-lifecycle.kernel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { pathMayExistSync } from "./path-existence.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

export {
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_CRASH_LOOP_RECOVERED_REASON,
} from "./gateway-boot-lifecycle.kernel.js";

// Keep enough history for operator forensics while bounding lifecycle-segment
// growth. Retention must comfortably exceed GATEWAY_BOOT_LOOP_WINDOW_MS.
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;
export const GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS = 500;
export const GATEWAY_SIGNAL_REPEAT_WINDOW_MS = 5 * 60_000;

export function formatGatewayRepeatedSignalHint(
  signal: NodeJS.Signals,
  count: number,
  observation: "received" | "stopped after" = "received",
): string {
  return `${observation} ${signal} ${count} times in 5 min: another supervisor may be managing this Gateway — see \`openclaw gateway status --deep\``;
}
/**
 * The breaker only self-clears after the full window drains. Operator surfaces name the manual
 * override command, not the internal RPC. Account hints carry accountId to avoid starting a
 * different default account than the warning named.
 */
export function formatGatewayCrashLoopManualChannelStartHint(target?: {
  channelId: string;
  accountId?: string;
}): string {
  const params = JSON.stringify({
    channel: target?.channelId ?? "<id>",
    ...(target?.accountId ? { accountId: target.accountId } : {}),
  });
  const command = formatCliCommand("openclaw gateway call channels.start");
  return `Start a channel manually with: ${command} --params '${params}'`;
}

const gatewayLifecycleLog = createSubsystemLogger("gateway/lifecycle");

type GatewayBootLifecycleDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_boot_lifecycle">;

type GatewayBootLifecycleOutcome =
  | "clean_stop"
  | "planned_restart"
  | "safe_mode_stable"
  | "startup_failed"
  | "startup_failure_repaired"
  | "forced_stop";

export type GatewayBootLifecycleCompletion = {
  outcome: GatewayBootLifecycleOutcome;
  reason?: string;
  startupReason?: string;
};

export type GatewayCrashLoopBreakerDecision = ReturnType<
  typeof buildGatewayCrashLoopBreakerDecision
>;

export function readGatewayLastShutdown(
  env: NodeJS.ProcessEnv = process.env,
): { reason: string | null; completedAtMs: number } | undefined {
  try {
    return withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
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
        return row?.completedAtMs == null
          ? undefined
          : { ...row, completedAtMs: row.completedAtMs };
      },
      { env },
    );
  } catch {
    return undefined;
  }
}

export function readGatewayLastInstallationReplacement(env: NodeJS.ProcessEnv = process.env) {
  const lastShutdown = readGatewayLastShutdown(env);
  if (!lastShutdown?.reason?.startsWith("gateway.installation_replaced:")) {
    return undefined;
  }
  return { reason: lastShutdown.reason, completedAtMs: lastShutdown.completedAtMs };
}

export function inspectGatewayCrashLoopBreaker(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): GatewayCrashLoopBreakerDecision {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    return inspectGatewayCrashLoopBreakerInDatabase(db, nowMs);
  } catch (err) {
    gatewayLifecycleLog.warn(`crash-loop breaker state unavailable; fail-open: ${String(err)}`);
    return buildGatewayCrashLoopBreakerDecision({ uncleanBoots: 0 });
  }
}

/** Runtime readers share the boot owner's decision without opening SQLite on the main thread. */
export async function inspectGatewayCrashLoopBreakerAsync(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  signal?: AbortSignal,
): Promise<GatewayCrashLoopBreakerDecision> {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "gatewayBoot.breaker", input: nowMs },
    { signal, current: true },
  );
  if (reply && (!reply.ok || reply.type !== "gatewayBoot.breaker")) {
    throw new Error("Unexpected Gateway crash-loop breaker result");
  }
  return reply?.decision ?? buildGatewayCrashLoopBreakerDecision({ uncleanBoots: 0 });
}

export function recordGatewayBootStart(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  reason?: string,
): string | undefined {
  const bootId = randomUUID();
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("gateway_boot_lifecycle")
            .where("started_at_ms", "<", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS),
        );
        executeSqliteQuerySync(
          db,
          kysely.insertInto("gateway_boot_lifecycle").values({
            boot_id: bootId,
            pid: process.pid,
            started_at_ms: nowMs,
            completed_at_ms: null,
            outcome: null,
            startup_reason: reason ?? null,
            reason: null,
          }),
        );
      },
      { env },
    );
    return bootId;
  } catch (err) {
    gatewayLifecycleLog.warn(`failed to persist gateway boot start; fail-open: ${String(err)}`);
    return undefined;
  }
}

/**
 * Split a stable safe-mode lifetime before channel autostart resumes. A fresh
 * open row makes a process death during recovered channel startup count toward
 * the next breaker decision instead of aging out with the original boot.
 */
export async function recordGatewayCrashLoopRecovery(
  bootId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs?: number,
  assertCurrent?: () => void,
): Promise<string | undefined> {
  try {
    const context = captureOpenClawStateWorkerContext({ env });
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "gatewayBoot.recover", input: { bootId, nowMs } }),
      {
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(() => {
          context.admission.assertCurrent();
          assertCurrent?.();
        }, [context.admission.databasePath]),
      },
    );
  } catch (err) {
    gatewayLifecycleLog.warn(
      `failed to persist gateway crash-loop recovery; fail-safe: ${String(err)}`,
    );
    return undefined;
  }
}

export function completeGatewayBootLifecycle(
  bootId: string | undefined,
  completion: GatewayBootLifecycleCompletion,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): void {
  if (!bootId) {
    return;
  }
  const signal =
    completion.outcome !== "clean_stop"
      ? undefined
      : completion.reason === "stop (SIGTERM)"
        ? "SIGTERM"
        : completion.reason === "stop (SIGINT)"
          ? "SIGINT"
          : undefined;
  try {
    const recentStops = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("gateway_boot_lifecycle")
            .set({
              completed_at_ms: nowMs,
              outcome: completion.outcome,
              ...(completion.startupReason ? { startup_reason: completion.startupReason } : {}),
              reason: completion.reason ?? null,
            })
            .where("boot_id", "=", bootId),
        );
        return signal
          ? executeSqliteQueryTakeFirstSync(
              db,
              kysely
                .selectFrom("gateway_boot_lifecycle")
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("outcome", "=", "clean_stop")
                .where("reason", "=", completion.reason ?? null)
                .where("completed_at_ms", ">=", nowMs - GATEWAY_SIGNAL_REPEAT_WINDOW_MS),
            )?.count
          : undefined;
      },
      { env },
    );
    if (signal && recentStops !== undefined && recentStops >= 3) {
      gatewayLifecycleLog.warn(
        formatGatewayRepeatedSignalHint(signal, recentStops, "stopped after"),
      );
    }
  } catch (err) {
    gatewayLifecycleLog.warn(`failed to persist gateway boot outcome; fail-open: ${String(err)}`);
  }
}

export function repairGatewayMaintenanceStartupFailures(
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!pathMayExistSync(resolveOpenClawStateSqlitePath(env))) {
    return 0;
  }
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<GatewayBootLifecycleDatabase>(db);
        const result = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("gateway_boot_lifecycle")
            .set({ outcome: "startup_failure_repaired" })
            .where("outcome", "=", "startup_failed")
            .where("startup_reason", "in", maintenanceStartupReasons),
        );
        return Number(result.numAffectedRows ?? 0);
      },
      { env },
    );
  } catch (err) {
    gatewayLifecycleLog.warn(
      `failed to repair maintenance startup history; fail-open: ${String(err)}`,
    );
    return 0;
  }
}
