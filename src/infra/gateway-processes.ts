// Inspects local gateway processes for status and diagnostics.
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { classifyOpenClawArgv } from "./gateway-process-argv.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import { readWindowsListeningPidsOnPortSync } from "./windows-port-pids.js";

// Verify argv or current recorded ownership before signaling or reporting
// listener PIDs so stale port owners cannot be mistaken for OpenClaw.

type GatewayProcessContext = { env?: NodeJS.ProcessEnv; port?: number };

function inspectGatewayProcess(pid: number, context: GatewayProcessContext) {
  try {
    const options = { ...context, pid, command: "gateway" };
    const identity = classifyOpenClawArgv(
      readGatewayLockProcessCmdline(pid, process.platform, 1000, undefined, context.env) ?? [],
      options,
    );
    return identity.kind === "openclaw" || process.platform !== "win32"
      ? identity
      : classifyOpenClawArgv([], {
          ...options,
          owner: readGatewayOwnerLease({ ...context, current: true }),
        });
  } catch {
    return { kind: "unclassified", reason: "process ownership inspection failed" } as const;
  }
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

/** Find listener PIDs on `port` and keep only verified gateway processes. */
export function findVerifiedGatewayListenerPidsOnPortSync(
  port: number,
  context: { env?: NodeJS.ProcessEnv } = {},
): number[] {
  const rawPids =
    process.platform === "win32"
      ? readWindowsListeningPidsOnPortSync(port)
      : findUnixGatewayPidsOnPortSync(port);

  return uniqueValues(rawPids)
    .filter((pid): pid is number => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => inspectGatewayProcess(pid, { ...context, port }).kind === "openclaw");
}

/** Format gateway PIDs for human-facing diagnostics. */
export function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}
