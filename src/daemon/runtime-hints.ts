// 引入路径转换和日志路径解析工具
import { toPosixPath } from "./output.js";
import { resolveGatewayLogPaths, resolveGatewayRestartLogPath } from "./restart-logs.js";

/**
 * 转换为 Darwin 显示路径
 * 移除 Windows 风格的驱动器前缀
 * @param value - 原始路径
 * @returns Darwin 风格的路径
 */
function toDarwinDisplayPath(value: string): string {
  return toPosixPath(value).replace(/^[A-Za-z]:/, "");
}

/**
 * 构建平台运行时日志提示
 * @param params - 参数对象
 * @returns 格式化的提示字符串数组
 */
export function buildPlatformRuntimeLogHints(params: {
  platform?: NodeJS.Platform;       // 平台类型
  env?: NodeJS.ProcessEnv;         // 环境变量
  systemdServiceName: string;       // systemd 服务名称
  windowsTaskName: string;         // Windows 任务名称
}): string[] {
  const platform = params.platform ?? process.platform;
  const env = { ...process.env, ...params.env };

  if (platform === "darwin") {
    // macOS: Launchd 日志路径
    const logs = resolveGatewayLogPaths(env);
    return [
      `Launchd stdout (if installed): ${toDarwinDisplayPath(logs.stdoutPath)}`,
      `Launchd stderr (if installed): ${toDarwinDisplayPath(logs.stderrPath)}`,
      `Restart attempts: ${toDarwinDisplayPath(resolveGatewayRestartLogPath(env))}`,
    ];
  }

  if (platform === "linux") {
    // Linux: journalctl 命令
    return [
      `Logs: journalctl --user -u ${params.systemdServiceName}.service -n 200 --no-pager`,
      `Restart attempts: ${resolveGatewayRestartLogPath(env)}`,
    ];
  }

  if (platform === "win32") {
    // Windows: schtasks 查询命令
    return [
      `Logs: schtasks /Query /TN "${params.windowsTaskName}" /V /FO LIST`,
      `Restart attempts: ${resolveGatewayRestartLogPath(env)}`,
    ];
  }

  // 不支持的平台返回空数组
  return [];
}

/**
 * 构建平台服务启动提示
 * @param params - 参数对象
 * @returns 格式化的提示字符串数组
 */
export function buildPlatformServiceStartHints(params: {
  platform?: NodeJS.Platform;         // 平台类型
  installCommand: string;            // 安装命令
  startCommand: string;               // 启动命令
  launchAgentPlistPath: string;       // LaunchAgent plist 路径
  systemdServiceName: string;         // systemd 服务名称
  windowsTaskName: string;           // Windows 任务名称
}): string[] {
  const platform = params.platform ?? process.platform;
  // 基础命令：安装和启动
  const base = [params.installCommand, params.startCommand];

  switch (platform) {
    case "darwin":
      // macOS: 使用 launchctl bootstrap
      return [...base, `launchctl bootstrap gui/$UID ${params.launchAgentPlistPath}`];
    case "linux":
      // Linux: 使用 systemctl start
      return [...base, `systemctl --user start ${params.systemdServiceName}.service`];
    case "win32":
      // Windows: 使用 schtasks /Run
      return [...base, `schtasks /Run /TN "${params.windowsTaskName}"`];
    default:
      // 不支持的平台只返回基础命令
      return base;
  }
}
