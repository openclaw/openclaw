import { spawn } from "node:child_process";
import { triggerOpenClawRestart } from "./restart.js";
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
    // Actively trigger a supervisor restart rather than relying solely on
    // Restart= policy to pick up the exit.  This also runs
    // cleanStaleGatewayProcessesSync() first to remove any upstream process
    // still holding the port — a key guard against the restart-loop described
    // in issue #33103.
    //
    // On macOS under launchd, kickstart bypasses ThrottleInterval delays.
    // On Linux under systemd, `systemctl restart` is equivalent and ensures
    // the unit is restarted even when the service is configured with
    // Restart=on-failure (which does not restart on a clean exit code 0).
    const restart = triggerOpenClawRestart();
    if (!restart.ok) {
      return {
        mode: "failed",
        detail: restart.detail ?? `${restart.method} restart failed`,
      };
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
