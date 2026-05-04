import { spawn, type ChildProcess } from "node:child_process";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "../daemon/constants.js";
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

function isTruthy(value: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function spawnDetachedGatewayProcess(): { child: ChildProcess; pid?: number } {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const child = spawn(process.execPath, args, {
    env: process.env,
    detached: true,
    stdio: "inherit",
  });
  child.unref();
  return { child, pid: child.pid ?? undefined };
}

/**
 * Check if the current process appears to be running inside the gateway process tree.
 * When running under a supervisor (systemd/launchd), child process exit doesn't trigger
 * supervisor restart of the parent gateway. This detection helps avoid silent failures.
 * 
 * This is a conservative check: if we detect service environment markers, we assume
 * we might be inside the gateway process tree. The main gateway process would also
 * have these markers, but it's less common for the main process to invoke `openclaw update`
 * on itself. Users can use `--no-restart` flag if they need to update from within.
 */
function isRunningInsideGatewayProcessTree(env: NodeJS.ProcessEnv = process.env): boolean {
  // Check if we're running as a service (has service marker)
  const serviceMarker = env.OPENCLAW_SERVICE_MARKER?.trim();
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  if (serviceMarker !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  if (serviceKind && serviceKind !== GATEWAY_SERVICE_KIND) {
    return false;
  }
  
  // We have service environment markers. This could mean:
  // 1. We're the main gateway process (should be able to restart)
  // 2. We're a child process (agent exec) - restart would fail silently
  // 
  // Since we can't easily distinguish between these cases without PPID ancestry
  // checking, we take the conservative approach: error and let user use --no-restart
  // or run from external shell.
  return true;
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - otherwise: spawn detached child with current argv/execArgv, then caller exits
 */
export function restartGatewayProcessWithFreshPid(): GatewayRespawnResult {
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const supervisor = detectRespawnSupervisor(process.env);
  if (supervisor) {
    // Check if we're running inside the gateway process tree (#75691)
    // When invoked from a child process of the gateway (e.g., agent exec),
    // exiting the child doesn't trigger supervisor restart of the parent.
    if (isRunningInsideGatewayProcessTree(process.env)) {
      return {
        mode: "failed",
        detail: "openclaw update detected it is running inside the gateway process tree. The supervised-mode restart cannot fire from this context. Run `openclaw update` from an external shell (SSH, cron, or other detached session). To install without restart from this context, pass --no-restart and manually invoke `sudo systemctl restart <unit>` from outside.",
      };
    }
    
    // On macOS launchd, exit cleanly and let KeepAlive relaunch the service.
    // Avoid detached kickstart/start handoffs here so restart timing stays tied
    // to launchd's native supervision rather than a second helper process.
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

  try {
    const { pid } = spawnDetachedGatewayProcess();
    return { mode: "spawned", pid };
  } catch (err) {
    const detail = formatErrorMessage(err);
    return { mode: "failed", detail };
  }
}

/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * Unlike the generic restart path, update mode allows detached respawn on
 * unmanaged Windows installs because there is no safe in-process fallback once
 * the installed package contents have been replaced.
 */
export function respawnGatewayProcessForUpdate(): GatewayUpdateRespawnResult {
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" };
  }
  const supervisor = detectRespawnSupervisor(process.env);
  if (supervisor) {
    // Check if we're running inside the gateway process tree (#75691)
    // When invoked from a child process of the gateway (e.g., agent exec),
    // exiting the child doesn't trigger supervisor restart of the parent.
    if (isRunningInsideGatewayProcessTree(process.env)) {
      return {
        mode: "failed",
        detail: "openclaw update detected it is running inside the gateway process tree. The supervised-mode restart cannot fire from this context. Run `openclaw update` from an external shell (SSH, cron, or other detached session). To install without restart from this context, pass --no-restart and manually invoke `sudo systemctl restart <unit>` from outside.",
      };
    }
    
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
    const { child, pid } = spawnDetachedGatewayProcess();
    return { mode: "spawned", pid, child };
  } catch (err) {
    return {
      mode: "failed",
      detail: formatErrorMessage(err),
    };
  }
}
