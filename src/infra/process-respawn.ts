import { spawn } from "node:child_process";
import { hasSupervisorHint } from "./supervisor-markers.js";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

export type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLikelySupervisedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasSupervisorHint(env);
}

/**
 * Spawn a detached `launchctl kickstart -k` to force an immediate launchd
 * restart, bypassing ThrottleInterval.  The -k flag sends SIGTERM to the
 * current process, so this MUST be non-blocking (spawn, not spawnSync) to
 * avoid deadlocking — the gateway needs to be free to handle the signal
 * and exit so launchd can start the replacement.
 */
function schedulelaunchdKickstart(label: string): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const target = uid !== undefined ? `gui/${uid}/${label}` : label;
  try {
    const child = spawn("launchctl", ["kickstart", "-k", target], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {}); // best-effort; suppress uncaught error event
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
export function restartGatewayProcessWithFreshPid(): GatewayRespawnResult {
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  if (isLikelySupervisedProcess(process.env)) {
    // On macOS under launchd, fire a detached kickstart so launchd restarts
    // us immediately instead of waiting for ThrottleInterval (up to 60s).
    if (process.platform === "darwin" && process.env.OPENCLAW_LAUNCHD_LABEL?.trim()) {
      schedulelaunchdKickstart(process.env.OPENCLAW_LAUNCHD_LABEL.trim());
    }
    return { mode: "supervised" };
  }

  try {
    const args = [...process.execArgv, ...process.argv.slice(1)];
    const child = spawn(process.execPath, args, {
      env: process.env,
      detached: true,
      stdio: "inherit",
    });
    child.unref();
    return { mode: "spawned", pid: child.pid ?? undefined };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { mode: "failed", detail };
  }
}
