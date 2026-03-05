import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import type { GatewayService } from "../../daemon/service.js";
import { findGatewayPidsOnPortSync } from "../../infra/restart-stale-pids.js";
import { probeGatewayStatus } from "./probe.js";

function isValidPid(pid: number | null | undefined): pid is number {
  return pid != null && Number.isFinite(pid) && pid > 0;
}

/**
 * Check whether a PID belongs to an openclaw process by reading /proc/<pid>/cmdline.
 * Returns true if the command line contains "openclaw", false otherwise.
 * On non-Linux or any error, returns true (optimistic — caller already filtered by port).
 */
function isOpenClawProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.toLowerCase().includes("openclaw");
  } catch {
    // /proc not available (non-Linux) or permission denied — assume it's ours.
    return true;
  }
}

/**
 * Find gateway PID by port using `ss` (available in most containers where lsof is not).
 * Parses `ss -tlnp` output for the given port and extracts the PID.
 * Validates that the process belongs to openclaw via /proc to avoid signaling unrelated processes.
 * Returns a single PID when unambiguous, null otherwise.
 */
function findPidWithSs(port: number): number | null {
  try {
    const res = spawnSync("ss", ["-tlnp", `sport = :${port}`], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (res.error || res.status !== 0) {
      return null;
    }
    // Match pid=<number> from ss output like: users:(("openclaw",pid=1234,fd=18))
    const pids = new Set<number>();
    const pidPattern = /pid=(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = pidPattern.exec(res.stdout)) !== null) {
      const pid = Number.parseInt(match[1], 10);
      if (isValidPid(pid) && pid !== process.pid && isOpenClawProcess(pid)) {
        pids.add(pid);
      }
    }
    return pids.size === 1 ? [...pids][0] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the running gateway process PID.
 *
 * Resolution order:
 *   1. GatewayService.readRuntime() — works when a service manager (systemd/launchd) is active.
 *   2. Port-based discovery via lsof — common on macOS and full Linux installs.
 *   3. Port-based discovery via ss — fallback for minimal containers without lsof.
 *
 * On Windows: returns null immediately (process.kill with SIGUSR1 is not supported).
 * Returns null on any error — caller is responsible for falling back.
 */
export async function resolveGatewayPid(service: GatewayService): Promise<number | null> {
  if (process.platform === "win32") {
    return null;
  }

  // Primary: service manager PID (systemd/launchd).
  try {
    const runtime = await service.readRuntime(process.env);
    if (isValidPid(runtime.pid)) {
      return runtime.pid;
    }
  } catch {
    // Service manager unavailable — fall through to port-based discovery.
  }

  let port: number;
  try {
    const cfg = loadConfig();
    port = resolveGatewayPort(cfg, process.env);
  } catch {
    try {
      port = resolveGatewayPort(undefined, process.env);
    } catch {
      return null;
    }
  }

  // Fallback 1: lsof-based discovery.
  const lsofPids = findGatewayPidsOnPortSync(port);
  if (lsofPids.length === 1) {
    return lsofPids[0];
  }

  // Fallback 2: ss-based discovery (containers without lsof).
  if (lsofPids.length === 0) {
    const ssPid = findPidWithSs(port);
    if (ssPid !== null) {
      return ssPid;
    }
  }

  return null;
}

/**
 * Poll gateway health using two-phase WS RPC probing until the new process is confirmed healthy.
 *
 * Two-phase approach eliminates the false-positive risk of a fixed initial delay:
 *   Phase 1 — wait for old process DOWN (ok: false): confirms shutdown has occurred.
 *   Phase 2 — wait for new process UP (ok: true): confirms the respawned process is healthy.
 */
export async function pollUntilGatewayHealthy(params: {
  url: string;
  token?: string;
  password?: string;
  timeoutMs: number;
  intervalMs?: number;
}): Promise<boolean> {
  const intervalMs = params.intervalMs ?? 500;
  const deadline = Date.now() + params.timeoutMs;

  const probe = async (): Promise<{ ok: boolean }> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false };
    }
    return probeGatewayStatus({
      url: params.url,
      token: params.token,
      password: params.password,
      timeoutMs: Math.min(2_000, remaining),
      json: true,
    });
  };

  // Phase 1: wait for old process to go DOWN (ok: false).
  while (Date.now() < deadline) {
    const result = await probe();
    if (!result.ok) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  // Phase 2: wait for new process to come UP (ok: true).
  while (Date.now() < deadline) {
    const result = await probe();
    if (result.ok) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}
