// Defines process supervisor marker labels for gateway diagnostics.
import { spawnSync } from "node:child_process";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_WINDOWS_TASK_NAME,
  resolveGatewayLaunchAgentLabel,
} from "../daemon/constants.js";

const SUPERVISOR_HINTS = {
  launchd: ["OPENCLAW_LAUNCHD_LABEL"],
  systemd: ["OPENCLAW_SYSTEMD_UNIT", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"],
  schtasks: ["OPENCLAW_WINDOWS_TASK_NAME"],
} as const;

/** Environment keys that imply the gateway process is supervised by an external respawner. */
export const SUPERVISOR_HINT_ENV_VARS = [
  "LAUNCH_JOB_LABEL",
  "LAUNCH_JOB_NAME",
  "XPC_SERVICE_NAME",
  ...SUPERVISOR_HINTS.launchd,
  ...SUPERVISOR_HINTS.systemd,
  ...SUPERVISOR_HINTS.schtasks,
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
] as const;

/** Supported supervisor families that can respawn the gateway after update/restart handoff. */
export type RespawnSupervisor = "launchd" | "systemd" | "schtasks";

interface DetectRespawnSupervisorOptions {
  includeLinuxOpenClawGatewayServiceMarker?: boolean;
}

function hasAnyHint(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function hasOpenClawGatewayServiceMarker(env: NodeJS.ProcessEnv): boolean {
  return (
    env.OPENCLAW_SERVICE_MARKER?.trim() === "openclaw" &&
    env.OPENCLAW_SERVICE_KIND?.trim() === "gateway"
  );
}

function isCurrentGatewayLaunchdJob(env: NodeJS.ProcessEnv): boolean {
  const expectedLabel = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
  if (
    [env.LAUNCH_JOB_LABEL, env.LAUNCH_JOB_NAME].some((value) => value?.trim() === expectedLabel)
  ) {
    return true;
  }
  return env.XPC_SERVICE_NAME?.trim() === GATEWAY_LAUNCH_AGENT_LABEL;
}

const SCHTASKS_QUERY_TIMEOUT_MS = 3_000;

/**
 * Probe for the OpenClaw gateway scheduled task on Windows via schtasks /Query.
 * Returns true when the task exists and is queryable, regardless of environment
 * variables. This covers the case where the gateway was started manually (e.g.
 * `openclaw.mjs gateway`) instead of through the scheduled task, so the
 * expected service env vars are missing.
 */
function probeWindowsScheduledTask(taskName: string): boolean {
  try {
    const result = spawnSync("schtasks.exe", ["/Query", "/TN", taskName], {
      timeout: SCHTASKS_QUERY_TIMEOUT_MS,
      stdio: "pipe",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Detects the current platform supervisor from process environment hints. */
export function detectRespawnSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: DetectRespawnSupervisorOptions = {},
): RespawnSupervisor | null {
  if (platform === "darwin") {
    return hasAnyHint(env, SUPERVISOR_HINTS.launchd) || isCurrentGatewayLaunchdJob(env)
      ? "launchd"
      : null;
  }
  if (platform === "linux") {
    return hasAnyHint(env, SUPERVISOR_HINTS.systemd) ||
      (options.includeLinuxOpenClawGatewayServiceMarker === true &&
        hasOpenClawGatewayServiceMarker(env))
      ? "systemd"
      : null;
  }
  if (platform === "win32") {
    if (hasAnyHint(env, SUPERVISOR_HINTS.schtasks)) {
      return "schtasks";
    }
    const marker = env.OPENCLAW_SERVICE_MARKER?.trim();
    const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
    if (marker && serviceKind === "gateway") {
      return "schtasks";
    }
    // If both service markers are explicitly set and don't match gateway,
    // respect the explicit signal (e.g. marker=worker means "not a gateway").
    // If only one is set (incomplete signal), we can't be certain — fall
    // through to the schtasks probe below.
    if (marker && serviceKind && serviceKind !== "gateway") {
      return null;
    }
    // Fallback: probe schtasks directly when no env vars are set at all (e.g.
    // gateway started manually instead of through the scheduled task).
    if (probeWindowsScheduledTask(GATEWAY_WINDOWS_TASK_NAME)) {
      return "schtasks";
    }
  }
  return null;
}
