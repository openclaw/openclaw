import { resolveGatewayLogPaths } from "./launchd.js";
import { toPosixPath } from "./output.js";

export function buildPlatformRuntimeLogHints(params: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  systemdServiceName: string;
  windowsTaskName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  if (platform === "darwin") {
    const logs = resolveGatewayLogPaths(env);
    return [
      `Launchd stdout (if installed): ${toPosixPath(logs.stdoutPath)}`,
      `Launchd stderr (if installed): ${toPosixPath(logs.stderrPath)}`,
    ];
  }
  if (platform === "linux") {
    return [`Logs: journalctl --user -u ${params.systemdServiceName}.service -n 200 --no-pager`];
  }
  if (platform === "win32") {
    return [`Logs: schtasks /Query /TN "${params.windowsTaskName}" /V /FO LIST`];
  }
  return [];
}

export function buildPlatformServiceStartHints(params: {
  platform?: NodeJS.Platform;
  installCommand: string;
  startCommand: string;
  launchAgentPlistPath: string;
  systemdServiceName: string;
  windowsTaskName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const base = [params.installCommand, params.startCommand];
  switch (platform) {
    case "darwin":
      return [...base, `launchctl bootstrap gui/$UID ${params.launchAgentPlistPath}`];
    case "linux":
      return [...base, `systemctl --user start ${params.systemdServiceName}.service`];
    case "win32":
      return [...base, `schtasks /Run /TN "${params.windowsTaskName}"`];
    default:
      return base;
  }
}
