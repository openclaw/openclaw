// Persists gateway boot outcomes for supervisor crash-loop decisions.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { uptime as osUptimeSeconds } from "node:os";
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
import type { GatewayBootLifecycleSegment } from "./gateway-boot-lifecycle-read.kernel.js";
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

export type { GatewayBootLifecycleSegment };

/**
 * Identifies the host boot the gateway process is running on. Two boot rows
 * carrying different authoritative kernel ids were separated by a host reboot;
 * two rows carrying the same kernel id were separated by a process death while
 * the host stayed up. The remedies differ, so the recorded cause has to tell
 * them apart.
 *
 * The kernel value is authoritative. The uptime fallback is only a coarse
 * bucket of the host start time, so attribution keeps its cause generic.
 */
const HOST_BOOT_ID_KERNEL_PREFIX = "kernel:";
const HOST_BOOT_ID_UPTIME_PREFIX = "uptime:";
// Wide enough to absorb ordinary clock discipline. This is a forensic hint,
// not a collision-free identity: two quick boots can occupy the same bucket.
const HOST_BOOT_ID_UPTIME_BUCKET_MS = 5 * 60_000;

let cachedHostBootId: string | undefined;

export function isInferredHostBootId(hostBootId: string | null | undefined): boolean {
  return typeof hostBootId === "string" && hostBootId.startsWith(HOST_BOOT_ID_UPTIME_PREFIX);
}

function resolveHostBootId(nowMs = Date.now()): string {
  if (cachedHostBootId) {
    return cachedHostBootId;
  }
  try {
    const kernelBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (kernelBootId) {
      cachedHostBootId = `${HOST_BOOT_ID_KERNEL_PREFIX}${kernelBootId}`;
      return cachedHostBootId;
    }
  } catch {
    // Not Linux, or /proc is not readable: fall through to the uptime estimate.
  }
  const hostStartedAtMs = nowMs - Math.round(osUptimeSeconds() * 1000);
  const bucket = Math.floor(hostStartedAtMs / HOST_BOOT_ID_UPTIME_BUCKET_MS);
  cachedHostBootId = `${HOST_BOOT_ID_UPTIME_PREFIX}${bucket}`;
  return cachedHostBootId;
}

/**
 * Reads recent boot segments oldest-first. Callers correlate their own
 * timestamps against these rows; this function makes no judgement about them.
 *
 * The query runs on the shared-state read worker: the gateway sweeper calls it
 * from the main thread, and a cold handle or a busy database must not block
 * unrelated gateway work while SQLite opens and scans.
 */
export async function readGatewayBootLifecycleSegments(params?: {
  env?: NodeJS.ProcessEnv;
  sinceMs?: number;
  limit?: number;
}): Promise<GatewayBootLifecycleSegment[]> {
  try {
    const reply = await executeExistingOpenClawStateRead(
      { env: params?.env ?? process.env },
      {
        type: "gatewayBootLifecycle.segments",
        ...(typeof params?.sinceMs === "number" ? { sinceMs: params.sinceMs } : {}),
        ...(typeof params?.limit === "number" ? { limit: params.limit } : {}),
      },
    );
    if (!reply) {
      // No database on disk yet: no boot history to attribute against.
      return [];
    }
    if (!reply.ok || reply.type !== "gatewayBootLifecycle.segments") {
      throw new Error("Unexpected gateway boot lifecycle read result");
    }
    return reply.segments;
  } catch (err) {
    gatewayLifecycleLog.warn(`boot lifecycle history unavailable; fail-open: ${String(err)}`);
    return [];
  }
}

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
    const hostBootId = resolveHostBootId(nowMs);
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
            host_boot_id: hostBootId,
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
    const hostBootId = resolveHostBootId(nowMs);
    const context = captureOpenClawStateWorkerContext({ env });
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({ type: "gatewayBoot.recover", input: { bootId, nowMs, hostBootId } }),
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
