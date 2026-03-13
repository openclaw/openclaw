import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";

export type LaunchdRestartHandoffMode = "kickstart" | "start-after-exit";

export type LaunchdRestartHandoffResult = {
  ok: boolean;
  pid?: number;
  detail?: string;
};

export type LaunchdRestartTarget = {
  domain: string;
  label: string;
  plistPath: string;
  serviceTarget: string;
};

// Give launchd a short window to reload the KeepAlive job on its own before
// attempting a manual repair/bootstrap path.
const START_AFTER_EXIT_PRINT_RETRY_COUNT = 15;
const START_AFTER_EXIT_PRINT_RETRY_DELAY_SECONDS = 0.2;

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

function resolveLaunchAgentLabel(env?: Record<string, string | undefined>): string {
  const envLabel = env?.OPENCLAW_LAUNCHD_LABEL?.trim();
  if (envLabel) {
    return envLabel;
  }
  return resolveGatewayLaunchAgentLabel(env?.OPENCLAW_PROFILE);
}

export function resolveLaunchdRestartTarget(
  env: Record<string, string | undefined> = process.env,
): LaunchdRestartTarget {
  const domain = resolveGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const home = env.HOME?.trim() || os.homedir();
  const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  return {
    domain,
    label,
    plistPath,
    serviceTarget: `${domain}/${label}`,
  };
}

export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const launchdLabel =
    env.LAUNCH_JOB_LABEL?.trim() || env.LAUNCH_JOB_NAME?.trim() || env.XPC_SERVICE_NAME?.trim();
  if (launchdLabel) {
    return launchdLabel === label;
  }
  const configuredLabel = env.OPENCLAW_LAUNCHD_LABEL?.trim();
  return Boolean(configuredLabel && configuredLabel === label);
}

function buildLaunchdRestartScript(mode: LaunchdRestartHandoffMode): string {
  const waitForCallerPid = `wait_pid="$4"
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  while kill -0 "$wait_pid" >/dev/null 2>&1; do
    sleep 0.1
  done
fi
`;

  if (mode === "kickstart") {
    return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
  }

  const verifyLaunchdReload = `print_retry_count="${START_AFTER_EXIT_PRINT_RETRY_COUNT}"
while [ "$print_retry_count" -gt 0 ]; do
  if launchctl print "$service_target" >/dev/null 2>&1; then
    exit 0
  fi
  print_retry_count=$((print_retry_count - 1))
  sleep ${START_AFTER_EXIT_PRINT_RETRY_DELAY_SECONDS}
done
`;

  return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
${verifyLaunchdReload}
launchctl enable "$service_target" >/dev/null 2>&1 || true
if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
  launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
else
  launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
fi
`;
}

export function scheduleDetachedLaunchdRestartHandoff(params: {
  env?: Record<string, string | undefined>;
  mode: LaunchdRestartHandoffMode;
  waitForPid?: number;
}): LaunchdRestartHandoffResult {
  const target = resolveLaunchdRestartTarget(params.env);
  const waitForPid =
    typeof params.waitForPid === "number" && Number.isFinite(params.waitForPid)
      ? Math.floor(params.waitForPid)
      : 0;
  try {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        buildLaunchdRestartScript(params.mode),
        "openclaw-launchd-restart-handoff",
        target.serviceTarget,
        target.domain,
        target.plistPath,
        String(waitForPid),
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...params.env },
      },
    );
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
