import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveGatewayLogPaths } from "../daemon/launchd.js";
import { formatRuntimeStatus } from "../daemon/runtime-format.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../daemon/systemd-hints.js";
import { isWSLEnv } from "../infra/wsl.js";
import { getResolvedLoggerSettings } from "../logging.js";

type RuntimeHintOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

export function formatGatewayRuntimeSummary(
  runtime: GatewayServiceRuntime | undefined,
): string | null {
  return formatRuntimeStatus(runtime);
}

export function buildGatewayRuntimeHints(
  runtime: GatewayServiceRuntime | undefined,
  options: RuntimeHintOptions = {},
): string[] {
  const hints: string[] = [];
  if (!runtime) {
    return hints;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (platform === "linux" && isSystemdUnavailableDetail(runtime.detail)) {
    hints.push(...renderSystemdUnavailableHints({ wsl: isWSLEnv() }));
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.cachedLabel && platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    hints.push(
      `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${label}`,
    );
    hints.push(`Then reinstall: ${formatCliCommand("openclaw gateway install", env)}`);
  }
  if (runtime.missingUnit) {
    hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.status === "stopped") {
    hints.push("Service is loaded but not running (likely exited immediately).");
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    if (platform === "darwin") {
      const logs = resolveGatewayLogPaths(env);
      hints.push(`Launchd stdout (if installed): ${logs.stdoutPath}`);
      hints.push(`Launchd stderr (if installed): ${logs.stderrPath}`);
    } else if (platform === "linux") {
      const unit = resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
      hints.push(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`);
    } else if (platform === "win32") {
      const task = resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
      hints.push(`Logs: schtasks /Query /TN "${task}" /V /FO LIST`);
    }
  }
  return hints;
}
