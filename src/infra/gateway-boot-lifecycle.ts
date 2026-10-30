// Persists gateway boot outcomes for supervisor crash-loop decisions.
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  buildGatewayCrashLoopBreakerDecision,
  maintenanceStartupReasons,
} from "./gateway-boot-lifecycle.kernel.js";
import { resolveGatewayPlatformSupervisor } from "./gateway-supervision.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { pathMayExistSync } from "./path-existence.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";

export {
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  GATEWAY_SIGNAL_REPEAT_WINDOW_MS,
} from "./gateway-boot-lifecycle.kernel.js";

export const GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS = 500;

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

/** Inspection keeps snapshot preparation off the caller's event loop. */
export async function readGatewayLastShutdownAsync(env = process.env) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "gatewayBoot.lastShutdown", input: undefined },
    { signal: getAsyncWorkSignal() },
  );
  return reply?.shutdown;
}

export async function readGatewayLastInstallationReplacementAsync(env = process.env) {
  const lastShutdown = await readGatewayLastShutdownAsync(env);
  return lastShutdown?.reason?.startsWith("gateway.installation_replaced:")
    ? { reason: lastShutdown.reason, completedAtMs: lastShutdown.completedAtMs }
    : undefined;
}

/** Decide from prior boots, then record this boot in the existing lifecycle writer. */
export async function beginGatewayBootLifecycle(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<{ decision: GatewayCrashLoopBreakerDecision; id: string | undefined }> {
  try {
    const context = captureOpenClawStateWorkerContext({ env });
    return await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({ type: "gatewayBoot.begin", input: nowMs }),
    );
  } catch (err) {
    gatewayLifecycleLog.warn(`crash-loop breaker state unavailable; fail-open: ${String(err)}`);
    return { decision: buildGatewayCrashLoopBreakerDecision({ uncleanBoots: 0 }), id: undefined };
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
  return reply?.decision ?? buildGatewayCrashLoopBreakerDecision({ uncleanBoots: 0 });
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

export async function completeGatewayBootLifecycle(
  bootId: string | undefined,
  completion: GatewayBootLifecycleCompletion,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<void> {
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
    const context = captureOpenClawStateWorkerContext({ env });
    const recentStops = await runOpenClawStateWorkerOperation(context, (scope) =>
      scope.execute({
        type: "gatewayBoot.complete",
        input: { bootId, completion, nowMs, countSignalStops: signal !== undefined },
      }),
    );
    if (signal && recentStops !== undefined && recentStops >= 3) {
      // A declared platform supervisor stops and replaces processes on purpose
      // (Pod deletes, rollouts); repeated stops there are not a competing owner.
      const platformSupervisor = resolveGatewayPlatformSupervisor(env);
      if (platformSupervisor) {
        gatewayLifecycleLog.info(
          `stopped after ${signal} ${recentStops} times in 5 min (${platformSupervisor === "kubernetes" ? "Kubernetes" : "external supervisor"} manages this Gateway)`,
        );
      } else {
        gatewayLifecycleLog.warn(
          formatGatewayRepeatedSignalHint(signal, recentStops, "stopped after"),
        );
      }
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
