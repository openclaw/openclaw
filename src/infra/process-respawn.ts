import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { scheduleDetachedLaunchdRestartHandoff } from "../daemon/launchd-restart-handoff.js";
import { logDebug } from "../logger.js";
import { triggerOpenClawRestart } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

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

let cachedPackageBinEntryPoint: string | undefined;
let didResolvePackageBinEntryPoint = false;

function resolvePackageBinEntryPoint(): string | undefined {
  if (didResolvePackageBinEntryPoint) {
    return cachedPackageBinEntryPoint;
  }
  didResolvePackageBinEntryPoint = true;
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { bin?: string | Record<string, string> };
    if (typeof packageJson.bin === "string") {
      cachedPackageBinEntryPoint = packageJson.bin;
      return cachedPackageBinEntryPoint;
    }
    if (packageJson.bin && typeof packageJson.bin === "object") {
      const [entryPoint] = Object.values(packageJson.bin);
      if (typeof entryPoint === "string" && entryPoint.length > 0) {
        cachedPackageBinEntryPoint = entryPoint;
        return cachedPackageBinEntryPoint;
      }
    }
  } catch {
    // Ignore package.json resolution failures and continue to argv fallback.
  }
  return cachedPackageBinEntryPoint;
}

function resolveRespawnEntryPoint(): string | undefined {
  const envEntryPoint = process.env.OPENCLAW_ENTRY_POINT?.trim();
  if (envEntryPoint) {
    return envEntryPoint;
  }
  const packageBinEntryPoint = resolvePackageBinEntryPoint();
  if (packageBinEntryPoint) {
    return packageBinEntryPoint;
  }
  const argvEntryPoint = process.argv[1];
  if (argvEntryPoint) {
    logDebug(`respawn: falling back to process.argv[1] for entry point: ${argvEntryPoint}`);
  }
  return argvEntryPoint;
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
    // Hand off launchd restarts to a detached helper before exiting so config
    // reloads and SIGUSR1-driven restarts do not depend on exit/respawn timing.
    if (supervisor === "launchd") {
      const handoff = scheduleDetachedLaunchdRestartHandoff({
        env: process.env,
        mode: "start-after-exit",
        waitForPid: process.pid,
      });
      if (!handoff.ok) {
        return {
          mode: "supervised",
          detail: `launchd exit fallback (${handoff.detail ?? "restart handoff failed"})`,
        };
      }
      return {
        mode: "supervised",
        detail: `launchd restart handoff pid ${handoff.pid ?? "unknown"}`,
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
  if (process.platform === "win32") {
    // Detached respawn is unsafe on Windows without an identified Scheduled Task:
    // the child becomes orphaned if the original process exits.
    return {
      mode: "disabled",
      detail: "win32: detached respawn unsupported without Scheduled Task markers",
    };
  }

  try {
    const entryPoint = resolveRespawnEntryPoint();
    const args = entryPoint
      ? [...process.execArgv, entryPoint, ...process.argv.slice(2)]
      : [...process.execArgv, ...process.argv.slice(1)];
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
