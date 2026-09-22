import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { readBestEffortConfig } from "../../config/config.js";
import { callGatewayCli } from "../../gateway/call.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
} from "../../infra/gateway-lock.js";
import {
  readGatewayOwnerLease,
  type GatewayOwnerLeaseIdentity,
} from "../../infra/gateway-owner-lease.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} from "../../infra/gateway-processes.js";
import {
  clearGatewayRestartIntentSync,
  type GatewayRestartIntent,
  writeGatewayRestartIntentSync,
} from "../../infra/restart-intent.js";
import { appendGatewayLifecycleAudit } from "./lifecycle-audit.js";

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
      "Gateway restart is disabled in the running gateway config (commands.restart=false); unmanaged SIGUSR1 restart would be ignored",
    );
  }
}

export function resolveVerifiedGatewayListenerPids(port: number): number[] {
  return findVerifiedGatewayListenerPidsOnPortSync(port).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0,
  );
}

export async function signalGatewayRestart(
  port: number,
  params: {
    restartIntent?: GatewayRestartIntent;
    enforceRestartConfig: boolean;
    processLabel: string;
    requireLockIdentity?: boolean;
    auditSource: "cli" | "supervisor";
    ownerLease?: GatewayOwnerLeaseIdentity;
    env?: NodeJS.ProcessEnv;
  },
) {
  if (params.enforceRestartConfig) {
    await assertUnmanagedGatewayRestartEnabled(port);
  }
  const pids = resolveVerifiedGatewayListenerPids(port);
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
  const requiresTargetedDelivery = params.requireLockIdentity === true || isWindows;
  const previousLockIdentity = requiresTargetedDelivery
    ? await readActiveGatewayLockIdentity({ env: params.env })
    : undefined;
  if (
    requiresTargetedDelivery &&
    (!previousLockIdentity ||
      previousLockIdentity.pid !== pid ||
      previousLockIdentity.port !== port)
  ) {
    throw new Error(
      `gateway lock identity does not match the verified listener on port ${port}; refusing an ambiguous restart`,
    );
  }
  const intentWritten = previousLockIdentity?.ownerId
    ? false
    : writeGatewayRestartIntentSync({
        targetPid: pid,
        reason: "gateway.restart",
        ...(params.restartIntent ? { intent: params.restartIntent } : {}),
      });
  if (requiresTargetedDelivery && !previousLockIdentity?.ownerId && !intentWritten) {
    throw new Error("failed to persist the gateway restart intent");
  }
  try {
    if (previousLockIdentity) {
      const currentLockIdentity = await readActiveGatewayLockIdentity({ env: params.env });
      if (
        !currentLockIdentity ||
        !isSameGatewayLockIdentity(previousLockIdentity, currentLockIdentity)
      ) {
        throw new Error(
          `gateway lock owner changed before the restart request could be delivered on port ${port}`,
        );
      }
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
        previousLockIdentity?.ownerId !== current.owner
      ) {
        throw new Error(`Foreground Gateway owner changed before restart on port ${port}`);
      }
    }
    if (previousLockIdentity?.ownerId) {
      const result = await callGatewayCli<{ pid: number }>({
        method: "gateway.restart.request",
        params: {
          reason: "gateway.restart",
          target: {
            pid,
            ownerId: previousLockIdentity.ownerId,
            port,
          },
          ...(params.restartIntent ? { restartIntent: params.restartIntent } : {}),
        },
        localPortOverride: port,
        ignoreEnvUrlOverride: true,
        timeoutMs: 10_000,
      });
      expectDefined(result.pid === pid ? result : undefined, "invalid restart acknowledgement");
    } else if (isWindows) {
      // Gateways started before lock owner IDs were introduced do not understand the
      // targeted payload. The exact loopback port plus the revalidated legacy lock is
      // the strongest available target; the PID-bound persisted intent carries options.
      await callGatewayCli({
        method: "gateway.restart.request",
        params: {
          reason: "gateway.restart",
          skipDeferral: true,
        },
        localPortOverride: port,
        ignoreEnvUrlOverride: true,
        timeoutMs: 10_000,
      });
    } else {
      signalVerifiedGatewayPidSync(pid, "SIGUSR1");
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
    mode: previousLockIdentity?.ownerId || isWindows ? "rpc" : "sigusr1",
    pid,
  });
  return {
    result: "restarted" as const,
    pid,
    previousLockIdentity,
    message: `Gateway restart request sent to ${params.processLabel} process on port ${port}: ${pid}.`,
  };
}
