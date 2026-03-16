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
  const clearRestartSentinel = `clear_restart_sentinel() {
  if [ -z "$OPENCLAW_RESTART_NOTIFY_SESSION_KEY" ] && [ -z "$OPENCLAW_RESTART_SENTINEL_PATH" ]; then
    return
  fi
  sentinel_path="$OPENCLAW_RESTART_SENTINEL_PATH"
  if [ -z "$sentinel_path" ]; then
    state_dir="$OPENCLAW_STATE_DIR"
    if [ -z "$state_dir" ]; then
      state_dir="$CLAWDBOT_STATE_DIR"
    fi
    if [ -z "$state_dir" ]; then
      state_dir="$HOME/.openclaw"
    fi
    sentinel_path="$state_dir/restart-sentinel.json"
  fi
  rm -f "$sentinel_path" >/dev/null 2>&1 || true
}
`;

  if (mode === "kickstart") {
    return `${clearRestartSentinel}service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
restart_ok=0
if launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
  restart_ok=1
else
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    if launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
      restart_ok=1
    fi
  fi
fi
if [ "$restart_ok" -ne 1 ]; then
  clear_restart_sentinel
fi
`;
  }

  return `${clearRestartSentinel}service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
restart_ok=0
if launchctl start "$service_target" >/dev/null 2>&1; then
  restart_ok=1
else
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    if launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
      restart_ok=1
    fi
  else
    if launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
      restart_ok=1
    fi
  fi
fi
if [ "$restart_ok" -ne 1 ]; then
  clear_restart_sentinel
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
