import type { GatewayService } from "../../daemon/service.js";
import { probeGatewayStatus } from "./probe.js";

/**
 * Resolve the running gateway process PID via the existing GatewayService.readRuntime().
 *
 * readRuntime() is already implemented for both systemd and launchd (tested) and returns
 * pid?: number. This avoids duplicating platform-specific PID logic.
 *
 * On Windows: returns null immediately (process.kill with SIGUSR1 is not supported).
 * Returns null on any error — caller is responsible for falling back to hard restart.
 */
export async function resolveGatewayPid(service: GatewayService): Promise<number | null> {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const runtime = await service.readRuntime(process.env);
    const pid = runtime.pid ?? null;
    // Guard: PID 0 is the kernel scheduler on Linux — process.kill(0, "SIGUSR1") sends to the
    // entire process group. Negative PIDs also have special semantics.
    // NaN guard: `NaN <= 0` is false in JavaScript, so NaN would bypass a naive `<= 0` check.
    if (pid === null || !Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/**
 * Poll gateway health using two-phase WS RPC probing until the new process is confirmed healthy.
 *
 * Uses probeGatewayStatus() from probe.ts (calls WS RPC "status"). probeGatewayStatus NEVER
 * throws; it always returns { ok: boolean, error? }.
 *
 * Two-phase approach eliminates the false-positive risk of a fixed initial delay:
 *   Phase 1 — wait for old process DOWN (ok: false): confirms shutdown has occurred.
 *   Phase 2 — wait for new process UP (ok: true): confirms the respawned process is healthy.
 *
 * Passes json: true on every tick to suppress the "Checking gateway status..." spinner.
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
