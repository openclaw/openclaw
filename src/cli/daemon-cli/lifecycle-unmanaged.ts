import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { readBestEffortConfig } from "../../config/config.js";
import { callGatewayCli } from "../../gateway/call.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
} from "../../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import type { GatewayOwnerLeaseIdentity } from "../../infra/gateway-owner-lease.types.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} from "../../infra/gateway-processes.js";
import { formatExternalSupervisorActionRequired } from "../../infra/gateway-supervision.js";
import { resolveGatewayRestartDrainTimeoutMs } from "../../infra/restart-budget.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  writeGatewayRestartIntentSync,
} from "../../infra/restart-intent.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { appendGatewayLifecycleAudit } from "./lifecycle-audit.js";
import { commandInterrupted } from "./lifecycle-core.js";
import {
  runSafeGatewayRestart,
  resolveGatewayRestartIntentOptions,
} from "./lifecycle-safe-restart.js";
import { createDaemonActionContext } from "./response.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  renderGatewayPortHealthDiagnostics,
  waitForGatewayHealthyListener,
} from "./restart-health.js";
import type { DaemonLifecycleOptions } from "./types.js";

async function assertUnmanagedGatewayRestartEnabled(port: number): Promise<void> {
  const cfg = await readBestEffortConfig({ observe: false }).catch(() => undefined);
  const scheme = cfg?.gateway?.tls?.enabled ? "wss" : "ws";
  const probe = await probeGateway({
    url: `${scheme}://127.0.0.1:${port}`,
    auth: {
      token: normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN),
      password: normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD),
    },
    timeoutMs: 1_000,
  }).catch(() => null);

  if (!probe?.ok) {
    return;
  }
  if (
    isRecord(probe.configSnapshot) &&
    !isRestartEnabled({ commands: probe.configSnapshot.commands })
  ) {
    throw new Error(
      "Gateway restart is disabled in the running gateway config (commands.restart=false)",
    );
  }
}

export async function signalGatewayRestart(
  port: number,
  params: {
    restartIntent?: GatewayRestartIntent;
    enforceRestartConfig: boolean;
    processLabel: string;
    auditSource: "cli" | "supervisor";
    ownerLease?: GatewayOwnerLeaseIdentity;
    env?: NodeJS.ProcessEnv;
  },
) {
  const restartIntent = params.restartIntent?.force
    ? { force: true, drainBudgetMs: params.restartIntent.waitMs }
    : params.restartIntent;
  const pids = findVerifiedGatewayListenerPidsOnPortSync(port, { env: params.env });
  if (pids.length === 0) {
    return null;
  }
  if (pids.length > 1) {
    throw new Error(
      `multiple gateway processes are listening on port ${port}: ${formatGatewayPidList(pids)}; use "openclaw gateway status --deep" before retrying restart`,
    );
  }
  const pid = expectDefined(pids[0], "pids entry at 0");
  if (params.ownerLease && params.ownerLease.pid !== pid) {
    throw new Error(
      `Port ${port} is owned by pid ${pid}, not the recorded foreground Gateway pid ${params.ownerLease.pid}; refusing restart`,
    );
  }
  const isWindows = process.platform === "win32";
  const previousLockIdentity = await readActiveGatewayLockIdentity({ env: params.env });
  if (
    !previousLockIdentity ||
    previousLockIdentity.pid !== pid ||
    previousLockIdentity.port !== port
  ) {
    throw new Error(
      `gateway lock identity does not match the verified listener on port ${port}; use "openclaw gateway status --deep" and restart through its supervisor or original terminal`,
    );
  }
  const assertTargetCurrent = async () => {
    const currentLockIdentity = await readActiveGatewayLockIdentity({ env: params.env });
    const currentPids = findVerifiedGatewayListenerPidsOnPortSync(port, { env: params.env });
    if (currentPids.length !== 1 || currentPids[0] !== pid) {
      throw new Error(`Gateway listener changed before restart on port ${port}`);
    }
    if (
      !currentLockIdentity ||
      currentLockIdentity.pid !== pid ||
      currentLockIdentity.port !== port ||
      currentLockIdentity.ownerId !== previousLockIdentity.ownerId ||
      !isSameGatewayLockIdentity(previousLockIdentity, currentLockIdentity)
    ) {
      throw new Error(
        `gateway lock owner changed before the restart request could be delivered on port ${port}; run "openclaw gateway status --deep" before retrying`,
      );
    }
    if (params.ownerLease) {
      const current = readGatewayOwnerLease({ env: params.env });
      if (
        !current ||
        current.state !== "live" ||
        current.owner !== params.ownerLease.owner ||
        current.pid !== pid ||
        current.startedAt !== params.ownerLease.startedAt ||
        current.mode !== "foreground" ||
        current.port !== port ||
        previousLockIdentity.ownerId !== current.owner
      ) {
        throw new Error(`Foreground Gateway owner changed before restart on port ${port}`);
      }
    }
  };
  if (params.enforceRestartConfig) {
    await assertTargetCurrent();
    await assertUnmanagedGatewayRestartEnabled(port);
    await assertTargetCurrent();
  }
  const intentWritten = previousLockIdentity.ownerId
    ? false
    : writeGatewayRestartIntentSync({
        targetPid: pid,
        reason: "gateway.restart",
        ...(params.restartIntent ? { intent: params.restartIntent } : {}),
      });
  if (!previousLockIdentity.ownerId && !intentWritten) {
    throw new Error("failed to persist the gateway restart intent");
  }
  try {
    await assertTargetCurrent();
    const ownerId = previousLockIdentity.ownerId;
    if (ownerId || isWindows) {
      // Pre-owner-ID Windows Gateways use the PID-bound persisted intent instead
      // of target fields they do not understand. The exact port and lock stay verified.
      const result = await callGatewayCli<{ pid: number }>({
        method: "gateway.restart.request",
        params: ownerId
          ? {
              reason: "gateway.restart",
              target: { pid, ownerId, port },
              ...(restartIntent ? { restartIntent } : {}),
            }
          : { reason: "gateway.restart", skipDeferral: true },
        localPortOverride: port,
        ignoreEnvUrlOverride: true,
        timeoutMs: 10_000,
      });
      if (ownerId) {
        expectDefined(result.pid === pid ? result : undefined, "invalid restart acknowledgement");
      }
    } else {
      // Pre-owner-ID releases use SIGUSR1. Current Gateways always publish an
      // owner ID and receive targeted RPC, leaving SIGUSR1 to Node's debugger.
      signalVerifiedGatewayPidSync(pid, "SIGUSR1", { env: params.env, port });
    }
  } catch (err) {
    if (intentWritten) {
      clearGatewayRestartIntentSync();
    }
    throw err;
  }
  appendGatewayLifecycleAudit({
    action: "restart",
    source: params.auditSource,
    mode: previousLockIdentity.ownerId || isWindows ? "rpc" : "sigusr1",
    pid,
  });
  return {
    result: "restarted" as const,
    pid,
    previousLockIdentity,
    message: `Gateway restart request sent to ${params.processLabel} process on port ${port}: ${pid}.`,
  };
}

export function postRestartHealthAttempts(): number {
  return process.platform === "win32"
    ? Math.ceil(resolveGatewayStartupTiming().deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS)
    : DEFAULT_RESTART_HEALTH_ATTEMPTS;
}

export function resolveRestartListenerHealthWait(restartIntent: GatewayRestartIntent | undefined) {
  const drainTimeoutMs = resolveGatewayRestartDrainTimeoutMs(restartIntent);
  const attempts =
    postRestartHealthAttempts() +
    Math.ceil((drainTimeoutMs ?? 0) / DEFAULT_RESTART_HEALTH_DELAY_MS);
  return {
    attempts,
    waitIndefinitelyForPreviousOwner: drainTimeoutMs === undefined,
    timeoutSeconds: Math.round((attempts * DEFAULT_RESTART_HEALTH_DELAY_MS) / 1000),
  };
}

export async function runExternalSupervisorRestart(opts: DaemonLifecycleOptions): Promise<boolean> {
  const { emitMessage, fail } = createDaemonActionContext({
    action: "restart",
    json: Boolean(opts.json),
  });
  const restartIntent = resolveGatewayRestartIntentOptions(opts);
  const lockIdentity = await readActiveGatewayLockIdentity().catch(() => undefined);
  if (!lockIdentity?.ownerId) {
    // Owner IDs and targeted restart semantics shipped together. Older Gateways
    // ignore target fields, so fail before a candidate can mutate their state.
    fail(
      "Gateway restart failed: the active Gateway lock predates targeted restart ownership; update the running Gateway before retrying",
    );
    return false;
  }
  if (opts.safe) {
    return await runSafeGatewayRestart(opts, { ...lockIdentity, ownerId: lockIdentity.ownerId });
  }

  let signaled: Awaited<ReturnType<typeof signalGatewayRestart>>;
  try {
    signaled = await signalGatewayRestart(lockIdentity.port, {
      restartIntent,
      enforceRestartConfig: false,
      processLabel: "externally supervised",
      auditSource: "supervisor",
    });
  } catch (err) {
    fail(`Gateway restart failed: ${String(err)}`);
    return false;
  }
  if (!signaled) {
    fail(
      `No verified gateway process is listening on port ${lockIdentity.port}. ${formatExternalSupervisorActionRequired("start the gateway")}`,
    );
    return false;
  }

  const healthWait = resolveRestartListenerHealthWait(restartIntent);
  let health: Awaited<ReturnType<typeof waitForGatewayHealthyListener>>;
  try {
    health = await waitForGatewayHealthyListener({
      port: lockIdentity.port,
      attempts: healthWait.attempts,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
      previousLockIdentity: signaled.previousLockIdentity,
      waitIndefinitelyForPreviousOwner: healthWait.waitIndefinitelyForPreviousOwner,
      signal: getAsyncWorkSignal(),
    });
  } catch (err) {
    // An accepted interrupt owns the exit status; a cancelled wait is not a restart failure.
    if (!commandInterrupted(err)) {
      throw err;
    }
    return false;
  }
  if (!health.healthy) {
    const message = `Gateway restart timed out after ${healthWait.timeoutSeconds}s waiting for health checks.`;
    fail(message, renderGatewayPortHealthDiagnostics(health));
    return false;
  }

  emitMessage({
    ok: true,
    result: signaled.result,
    message: signaled.message,
  });
  return true;
}
