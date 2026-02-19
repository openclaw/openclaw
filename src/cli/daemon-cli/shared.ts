import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveGatewayLogPaths } from "../../daemon/launchd.js";
import { formatRuntimeStatus } from "../../daemon/runtime-format.js";
import { pickPrimaryLanIPv4 } from "../../gateway/net.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import { parsePort } from "../shared/parse-port.js";

export { formatRuntimeStatus };
export { parsePort };

export function createCliStatusTextStyles() {
  const rich = isRich();
  return {
    rich,
    label: (value: string) => colorize(rich, theme.muted, value),
    accent: (value: string) => colorize(rich, theme.accent, value),
    infoText: (value: string) => colorize(rich, theme.info, value),
    okText: (value: string) => colorize(rich, theme.success, value),
    warnText: (value: string) => colorize(rich, theme.warn, value),
    errorText: (value: string) => colorize(rich, theme.error, value),
  };
}

export function resolveRuntimeStatusColor(status: string | undefined): (value: string) => string {
  const runtimeStatus = status ?? "unknown";
  return runtimeStatus === "running"
    ? theme.success
    : runtimeStatus === "stopped"
      ? theme.error
      : runtimeStatus === "unknown"
        ? theme.muted
        : theme.warn;
}

export function parsePortFromArgs(programArguments: string[] | undefined): number | null {
  if (!programArguments?.length) {
    return null;
  }
  for (let i = 0; i < programArguments.length; i += 1) {
    const arg = programArguments[i];
    if (arg === "--port") {
      const next = programArguments[i + 1];
      const parsed = parsePort(next);
      if (parsed) {
        return parsed;
      }
    }
    if (arg?.startsWith("--port=")) {
      const parsed = parsePort(arg.split("=", 2)[1]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

export function pickProbeHostForBind(
  bindMode: string,
  tailnetIPv4: string | undefined,
  customBindHost?: string,
) {
  if (bindMode === "custom" && customBindHost?.trim()) {
    return customBindHost.trim();
  }
  if (bindMode === "tailnet") {
    return tailnetIPv4 ?? "127.0.0.1";
  }
  if (bindMode === "lan") {
    return pickPrimaryLanIPv4() ?? "127.0.0.1";
  }
  return "127.0.0.1";
}

const SAFE_DAEMON_ENV_KEYS = [
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_NIX_MODE",
];

export function filterDaemonEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) {
    return {};
  }
  const filtered: Record<string, string> = {};
  for (const key of SAFE_DAEMON_ENV_KEYS) {
    const value = env[key];
    if (!value?.trim()) {
      continue;
    }
    filtered[key] = value.trim();
  }
  return filtered;
}

export function safeDaemonEnv(env: Record<string, string> | undefined): string[] {
  const filtered = filterDaemonEnv(env);
  return Object.entries(filtered).map(([key, value]) => `${key}=${value}`);
}

export function normalizeListenerAddress(raw: string): string {
  let value = raw.trim();
  if (!value) {
    return value;
  }
  value = value.replace(/^TCP\s+/i, "");
  value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
  return value.trim();
}

export function renderRuntimeHints(
  runtime: { missingUnit?: boolean; status?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!runtime) {
    return [];
  }
  const hints: string[] = [];
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (runtime.missingUnit) {
    hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.status === "stopped") {
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(env);
      hints.push(`Launchd stdout (if installed): ${logs.stdoutPath}`);
      hints.push(`Launchd stderr (if installed): ${logs.stderrPath}`);
    } else if (process.platform === "linux") {
      const unit = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
      hints.push(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`);
    } else if (process.platform === "win32") {
      const task = resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
      hints.push(`Logs: schtasks /Query /TN "${task}" /V /FO LIST`);
    }
  }
  return hints;
}

export function renderGatewayServiceStartHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = [
    formatCliCommand("openclaw gateway install", env),
    formatCliCommand("openclaw gateway", env),
  ];
  const profile = env.OPENCLAW_PROFILE;
  switch (process.platform) {
    case "darwin": {
      const label = resolveGatewayLaunchAgentLabel(profile);
      return [...base, `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${label}.plist`];
    }
    case "linux": {
      const unit = resolveGatewaySystemdServiceName(profile);
      return [...base, `systemctl --user start ${unit}.service`];
    }
    case "win32": {
      const task = resolveGatewayWindowsTaskName(profile);
      return [...base, `schtasks /Run /TN "${task}"`];
    }
    default:
      return base;
  }
}
