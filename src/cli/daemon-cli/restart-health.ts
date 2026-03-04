import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  classifyPortListener,
  formatPortDiagnostics,
  inspectPortUsage,
  type PortUsage,
} from "../../infra/ports.js";
import { killProcessTree } from "../../process/kill-tree.js";
import { sleep } from "../../utils.js";

export const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60_000;
export const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
export const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(
  DEFAULT_RESTART_HEALTH_TIMEOUT_MS / DEFAULT_RESTART_HEALTH_DELAY_MS,
);

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  staleGatewayPids: number[];
};

function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): boolean {
  return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}

function looksLikeAuthClose(code: number | undefined, reason: string | undefined): boolean {
  if (code !== 1008) {
    return false;
  }
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("scope") ||
    normalized.includes("role")
  );
}

async function confirmGatewayReachable(port: number): Promise<boolean> {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined;
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined;
  const probe = await probeGateway({
    url: `ws://127.0.0.1:${port}`,
    auth: token || password ? { token, password } : undefined,
    timeoutMs: 1_000,
  });
  return probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason);
}

export async function inspectGatewayRestart(params: {
  service: GatewayService;
  port: number;
  env?: NodeJS.ProcessEnv;
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const env = params.env ?? process.env;
  let runtime: GatewayServiceRuntime = { status: "unknown" };
  try {
    runtime = await params.service.readRuntime(env);
  } catch (err) {
    runtime = { status: "unknown", detail: String(err) };
  }

  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port);
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const fallbackListenerPids =
    params.includeUnknownListenersAsStale &&
    process.platform === "win32" &&
    runtime.status !== "running" &&
    portUsage.status === "busy"
      ? portUsage.listeners
          .filter((listener) => classifyPortListener(listener, params.port) === "unknown")
          .map((listener) => listener.pid)
          .filter((pid): pid is number => Number.isFinite(pid))
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) => listenerOwnedByRuntimePid({ listener, runtimePid }))
      : gatewayListeners.length > 0 ||
        (portUsage.status === "busy" && portUsage.listeners.length === 0);
  let healthy = running && ownsPort;
  if (!healthy && running && portUsage.status === "busy") {
    try {
      healthy = await confirmGatewayReachable(params.port);
    } catch {
      // best-effort probe
    }
  }
  const staleGatewayPids = Array.from(
    new Set([
      ...gatewayListeners
        .filter((listener) => Number.isFinite(listener.pid))
        .filter((listener) => {
          if (!running) {
            return true;
          }
          if (runtimePid == null) {
            return true;
          }
          return !listenerOwnedByRuntimePid({ listener, runtimePid });
        })
        .map((listener) => listener.pid as number),
      ...fallbackListenerPids.filter(
        (pid) => runtime.pid == null || pid !== runtime.pid || !running,
      ),
    ]),
  );

  return {
    runtime,
    portUsage,
    healthy,
    staleGatewayPids,
  };
}

export async function waitForGatewayHealthyRestart(params: {
  service: GatewayService;
  port: number;
  attempts?: number;
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayRestart({
    service: params.service,
    port: params.port,
    env: params.env,
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot.healthy) {
      return snapshot;
    }
    if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") {
      return snapshot;
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayRestart({
      service: params.service,
      port: params.port,
      env: params.env,
      includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
    });
  }

  return snapshot;
}

export function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[] {
  const lines: string[] = [];
  const runtimeSummary = [
    snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
    snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
    snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
    snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (runtimeSummary) {
    lines.push(`Service runtime: ${runtimeSummary}`);
  }

  if (snapshot.portUsage.status === "busy") {
    lines.push(...formatPortDiagnostics(snapshot.portUsage));
  } else {
    lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
  }

  if (snapshot.portUsage.errors?.length) {
    lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
  }

  return lines;
}

export async function terminateStaleGatewayPids(pids: number[]): Promise<number[]> {
  const targets = Array.from(
    new Set(pids.filter((pid): pid is number => Number.isFinite(pid) && pid > 0)),
  );
  for (const pid of targets) {
    killProcessTree(pid, { graceMs: 300 });
  }
  if (targets.length > 0) {
    await sleep(500);
  }
  return targets;
}
