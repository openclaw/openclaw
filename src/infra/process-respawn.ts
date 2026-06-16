// Respawns the gateway process when no supervisor handles restart.
import { spawn, type ChildProcess } from "node:child_process";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isContainerEnvironment } from "./container-environment.js";
import { formatErrorMessage } from "./errors.js";
import { triggerOpenClawRestart } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

type GatewayUpdateRespawnResult = GatewayRespawnResult & {
  child?: ChildProcess;
};
type GatewayRespawnOptions = {
  env?: NodeJS.ProcessEnv;
};

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isTruthy(value: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function detectOpenClawSupervisorMarker(
  env: NodeJS.ProcessEnv,
): ReturnType<typeof detectRespawnSupervisor> {
  if (process.platform === "darwin" && hasValue(env.OPENCLAW_LAUNCHD_LABEL)) {
    return "launchd";
  }
  if (process.platform === "linux" && hasValue(env.OPENCLAW_SYSTEMD_UNIT)) {
    return "systemd";
  }
  if (process.platform === "win32") {
    if (hasValue(env.OPENCLAW_WINDOWS_TASK_NAME)) {
      return "schtasks";
    }
    if (
      env.OPENCLAW_SERVICE_MARKER?.trim() === "openclaw" &&
      env.OPENCLAW_SERVICE_KIND?.trim() === "gateway"
    ) {
      return "schtasks";
    }
  }
  return null;
}

function spawnDetachedGatewayProcess(opts: GatewayRespawnOptions = {}): {
  child: ChildProcess;
  pid?: number;
} {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const child = spawn(process.execPath, args, {
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    detached: true,
    stdio: "inherit",
  });
  child.unref();
  return { child, pid: child.pid ?? undefined };
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - unmanaged environments: caller should keep in-process restart behavior so
 *   custom supervisors keep tracking the same gateway PID
 */
export function restartGatewayProcessWithFreshPid(
  _opts: GatewayRespawnOptions = {},
): GatewayRespawnResult {
  const explicitSupervisor = detectOpenClawSupervisorMarker(process.env);
  if (explicitSupervisor) {
    return completeSupervisorRespawn(explicitSupervisor);
  }
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const supervisor = detectRespawnSupervisor(process.env);
  if (supervisor) {
    return completeSupervisorRespawn(supervisor);
  }
  if (process.platform === "win32") {
    // Detached respawn is unsafe on Windows without an identified Scheduled Task:
    // the child becomes orphaned if the original process exits.
    return {
      mode: "disabled",
      detail: "win32: detached respawn unsupported without Scheduled Task markers",
    };
  }
  if (isContainerEnvironment()) {
    return {
      mode: "disabled",
      detail: "container: use in-process restart to keep PID 1 alive",
    };
  }

  return {
    mode: "disabled",
    detail: "unmanaged: use in-process restart to keep custom supervisor PID tracking stable",
  };
}

function completeSupervisorRespawn(
  supervisor: NonNullable<ReturnType<typeof detectRespawnSupervisor>>,
): GatewayRespawnResult {
  // Native supervisors already track the gateway process; exit cleanly and let
  // them relaunch instead of creating a helper process or keeping the old PID.
  if (supervisor === "schtasks") {
    const restart = triggerOpenClawRestart();
    if (!restart.ok) {
      return {
        mode: "failed",
        detail: restart.detail ?? `${restart.method} restart failed`,
      };
    }
  }
  return { mode: "supervised" };
}

/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * Unlike the generic restart path, update mode allows detached respawn on
 * unmanaged Windows installs because there is no safe in-process fallback once
 * the installed package contents have been replaced.
 */
export function respawnGatewayProcessForUpdate(
  opts: GatewayRespawnOptions = {},
): GatewayUpdateRespawnResult {
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" };
  }
  const supervisor = detectRespawnSupervisor(process.env, process.platform, {
    includeLinuxOpenClawGatewayServiceMarker: true,
  });
  if (supervisor) {
    if (supervisor === "schtasks") {
      const restart = triggerOpenClawRestart();
      if (!restart.ok) {
        return {
          mode: "failed",
          detail: restart.detail ?? `${restart.method} restart failed`,
        };
      }
    }
    return { mode: "supervised" };
  }
  try {
    const { child, pid } = spawnDetachedGatewayProcess(opts);
    return { mode: "spawned", pid, child };
  } catch (err) {
    return {
      mode: "failed",
      detail: formatErrorMessage(err),
    };
  }
}
