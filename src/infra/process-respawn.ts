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
    // On macOS under launchd, actively kickstart the supervised service to
    // bypass ThrottleInterval delays for intentional restarts.
    if (process.platform === "darwin" && process.env.OPENCLAW_LAUNCHD_LABEL?.trim()) {
      const restart = triggerOpenClawRestart();
      if (!restart.ok) {
        // When launchctl kickstart times out (ETIMEDOUT), the command was still
        // dispatched to launchd and the restart may be in-flight. Rather than
        // falling back to an in-process restart (which leaves the gateway in a
        // degraded state), exit cleanly so launchd's KeepAlive can start a
        // fresh process. (#36822)
        if (restart.detail?.includes("ETIMEDOUT")) {
          return {
            mode: "supervised",
            detail: `launchctl kickstart timed out; trusting launchd KeepAlive to restart (${restart.detail})`,
          };
        }
        return {
          mode: "failed",
          detail: restart.detail ?? "launchctl kickstart failed",
        };
      }
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
