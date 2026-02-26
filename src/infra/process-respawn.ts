import { spawn } from "node:child_process";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

export type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

const SUPERVISOR_HINT_ENV_VARS = [
  // macOS launchd — native env vars (may be set by launchd itself)
  "LAUNCH_JOB_LABEL",
  "LAUNCH_JOB_NAME",
  // macOS launchd — OpenClaw's own plist generator sets these via
  // buildServiceEnvironment() in service-env.ts. launchd does NOT
  // automatically inject LAUNCH_JOB_LABEL into the child environment,
  // so OPENCLAW_LAUNCHD_LABEL is the reliable supervised-mode signal.
  "OPENCLAW_LAUNCHD_LABEL",
  // Linux systemd
  "INVOCATION_ID",
  "SYSTEMD_EXEC_PID",
  "JOURNAL_STREAM",
  "OPENCLAW_SYSTEMD_UNIT",
  // Generic service marker (set by both launchd and systemd plist/unit generators)
  "OPENCLAW_SERVICE_MARKER",
];

function isTruthy(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLikelySupervisedProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return SUPERVISOR_HINT_ENV_VARS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
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
