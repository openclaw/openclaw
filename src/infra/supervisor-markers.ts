import { spawnSync } from "node:child_process";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";

const LAUNCHD_SUPERVISOR_HINT_ENV_VARS = [
  "LAUNCH_JOB_LABEL",
  "LAUNCH_JOB_NAME",
  "OPENCLAW_LAUNCHD_LABEL",
] as const;

const SYSTEMD_SUPERVISOR_HINT_ENV_VARS = [
  "OPENCLAW_SYSTEMD_UNIT",
  "INVOCATION_ID",
  "SYSTEMD_EXEC_PID",
  "JOURNAL_STREAM",
] as const;

const WINDOWS_TASK_SUPERVISOR_HINT_ENV_VARS = ["OPENCLAW_WINDOWS_TASK_NAME"] as const;

export const SUPERVISOR_HINT_ENV_VARS = [
  ...LAUNCHD_SUPERVISOR_HINT_ENV_VARS,
  ...SYSTEMD_SUPERVISOR_HINT_ENV_VARS,
  ...WINDOWS_TASK_SUPERVISOR_HINT_ENV_VARS,
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
] as const;

export type RespawnSupervisor = "launchd" | "systemd" | "schtasks";

function hasAnyHint(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function detectLaunchdFromRuntime(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "darwin" || typeof process.getuid !== "function") {
    return false;
  }

  const uid = process.getuid();
  if (!Number.isInteger(uid) || uid < 0) {
    return false;
  }

  // OPENCLAW_LAUNCHD_LABEL is a launchd hint handled by the caller before runtime probing.
  // Runtime detection falls back to the canonical label derived from OPENCLAW_PROFILE.
  const label = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE).trim();
  if (!label) {
    return false;
  }

  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const result = spawnSync("launchctl", ["print", target], {
    encoding: "utf8",
    timeout: 1500,
  });
  if (result.error || result.status !== 0) {
    return false;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pidMatch = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  if (!pidMatch?.[1]) {
    return false;
  }

  const pid = Number.parseInt(pidMatch[1], 10);
  return Number.isFinite(pid) && pid > 1 && pid === process.pid;
}

export function detectRespawnSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RespawnSupervisor | null {
  if (platform === "darwin") {
    if (hasAnyHint(env, LAUNCHD_SUPERVISOR_HINT_ENV_VARS)) {
      return "launchd";
    }
    return detectLaunchdFromRuntime(env, platform) ? "launchd" : null;
  }
  if (platform === "linux") {
    return hasAnyHint(env, SYSTEMD_SUPERVISOR_HINT_ENV_VARS) ? "systemd" : null;
  }
  if (platform === "win32") {
    if (hasAnyHint(env, WINDOWS_TASK_SUPERVISOR_HINT_ENV_VARS)) {
      return "schtasks";
    }
    const marker = env.OPENCLAW_SERVICE_MARKER?.trim();
    const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
    return marker && serviceKind === "gateway" ? "schtasks" : null;
  }
  return null;
}
