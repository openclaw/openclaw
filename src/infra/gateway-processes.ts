import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import { readGatewayOwnerLease, readGatewayOwnerLeaseAsync } from "./gateway-owner-lease.js";
import type { GatewayOwnerLeaseIdentity } from "./gateway-owner-lease.types.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import { readWindowsListeningPidsOnPortSync } from "./windows-port-pids.js";

// Verify argv or current recorded ownership before signaling or reporting
// listener PIDs so stale port owners cannot be mistaken for OpenClaw.

type GatewayProcessContext = { env?: NodeJS.ProcessEnv; port?: number };

function inspectGatewayProcessArgv(pid: number, context: GatewayProcessContext) {
  const options = { ...context, pid, command: "gateway" };
  const identity = classifyOpenClawArgv(
    readGatewayLockProcessCmdline(pid, process.platform, 1000, undefined, context.env) ?? [],
    options,
  );
  return {
    identity,
    requiresLease: identity.kind !== "openclaw" && process.platform === "win32",
    withOwner: (owner: GatewayOwnerLeaseIdentity | undefined) =>
      classifyOpenClawArgv([], { ...options, owner }),
  };
}

function inspectGatewayProcess(pid: number, context: GatewayProcessContext) {
  try {
    const inspection = inspectGatewayProcessArgv(pid, context);
    return inspection.requiresLease
      ? inspection.withOwner(readGatewayOwnerLease({ ...context, current: true }))
      : inspection.identity;
  } catch {
    return { kind: "unclassified", reason: "process ownership inspection failed" } as const;
  }
}

/** Async service inspection keeps the same PID/port classification without synchronous snapshots. */
export async function findVerifiedGatewayListenerPidsOnPort(
  port: number,
  context: { env?: NodeJS.ProcessEnv } = {},
): Promise<number[]> {
  const signal = resolveSqliteInspectionSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
  const verified: number[] = [];
  for (const pid of gatewayListenerPidsOnPort(port)) {
    try {
      signal?.throwIfAborted();
      const inspection = inspectGatewayProcessArgv(pid, { ...context, port });
      const owner = inspection.requiresLease
        ? await readGatewayOwnerLeaseAsync({ ...context, port })
        : undefined;
      signal?.throwIfAborted();
      const current = inspection.requiresLease ? inspection.withOwner(owner) : inspection.identity;
      if (current.kind === "openclaw") {
        verified.push(pid);
      }
    } catch {
      signal?.throwIfAborted();
      // Unavailable ownership inspection cannot identify a listener.
    }
  }
  return verified;
}

/** Reinspect argv or current recorded ownership immediately before signaling. */
export function signalVerifiedGatewayPidSync(
  pid: number,
  signal: "SIGTERM" | "SIGUSR1",
  context: GatewayProcessContext = {},
): void {
  if (inspectGatewayProcess(pid, context).kind !== "openclaw") {
    throw new Error(`refusing to signal non-gateway process pid ${pid}`);
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    // The verified process can exit between argv inspection and signaling;
    // ESRCH already satisfies the requested stop or restart handoff.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      throw err;
    }
  }
}

export function findVerifiedGatewayListenerPidsOnPortSync(
  port: number,
  context: { env?: NodeJS.ProcessEnv } = {},
): number[] {
  return gatewayListenerPidsOnPort(port).filter(
    (pid) => inspectGatewayProcess(pid, { ...context, port }).kind === "openclaw",
  );
}

function gatewayListenerPidsOnPort(port: number): number[] {
  const rawPids =
    process.platform === "win32"
      ? readWindowsListeningPidsOnPortSync(port)
      : findUnixGatewayPidsOnPortSync(port);

  return uniqueValues(rawPids).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0 && pid !== process.pid,
  );
}

export function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}
