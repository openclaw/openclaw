// 引入字符串规范化工具
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
// 引入未来配置操作守卫
import { assertFutureConfigActionAllowed } from "./future-config-guard.js";
// 引入 launchd (macOS) 相关函数
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stageLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
// 引入 Windows 计划任务相关函数
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stageScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";
// 引入 systemd (Linux) 相关函数
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";
// 导出服务类型
export type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";

/**
 * 忽略服务写入结果（将返回值的函数转换为返回 void）
 * @param write - 写入函数
 * @returns 包装后的函数
 */
function ignoreServiceWriteResult<TArgs extends GatewayServiceInstallArgs>(
  write: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<void> {
  return async (args: TArgs) => {
    await write(args);
  };
}

// 网关服务类型定义
export type GatewayService = {
  label: string;       // 服务标签（如 "LaunchAgent"、"systemd"）
  loadedText: string;  // 已加载状态文本
  notLoadedText: string; // 未加载状态文本
  stage: (args: GatewayServiceStageArgs) => Promise<void>;              // 暂存服务
  install: (args: GatewayServiceInstallArgs) => Promise<void>;          // 安装服务
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;        // 卸载服务
  stop: (args: GatewayServiceControlArgs) => Promise<void>;             // 停止服务
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>; // 重启服务
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;        // 检查服务是否加载
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>; // 读取服务命令
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>; // 读取运行时信息
};

/**
 * 合并网关服务环境变量
 * @param baseEnv - 基础环境变量
 * @param command - 命令配置
 * @returns 合并后的环境变量
 */
function mergeGatewayServiceEnv(
  baseEnv: GatewayServiceEnv,
  command: GatewayServiceCommandConfig | null,
): GatewayServiceEnv {
  if (!command?.environment) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ...command.environment,
  };
}

/**
 * 读取网关服务状态
 * @param service - 网关服务
 * @param args - 环境参数
 * @returns 服务状态
 */
export async function readGatewayServiceState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  // 读取服务命令配置
  const command = await service.readCommand(baseEnv).catch(() => null);
  const env = mergeGatewayServiceEnv(baseEnv, command);
  // 并行检查加载状态和运行时信息
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env }).catch(() => false),
    service.readRuntime(env).catch(() => undefined),
  ]);
  return {
    installed: command !== null,   // 已安装意味着有命令配置
    loaded,                        // 是否已加载
    running: runtime?.status === "running", // 是否运行中
    env,
    command,
    runtime,
  };
}

/**
 * 启动网关服务
 * @param service - 网关服务
 * @param args - 控制参数
 * @returns 启动结果
 */
export async function startGatewayService(
  service: GatewayService,
  args: GatewayServiceControlArgs,
): Promise<GatewayServiceStartResult> {
  const state = await readGatewayServiceState(service, { env: args.env });
  // 未安装时返回 missing-install
  if (!state.loaded && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  try {
    // 尝试重启服务
    const restartResult = await service.restart({ ...args, env: state.env });
    const nextState = await readGatewayServiceState(service, { env: state.env });
    return {
      // 根据重启结果判断是立即启动还是计划启动
      outcome: restartResult.outcome === "scheduled" ? "scheduled" : "started",
      state: nextState,
    };
  } catch (err) {
    const nextState = await readGatewayServiceState(service, { env: state.env });
    // 安装丢失时返回 missing-install
    if (!nextState.installed) {
      return {
        outcome: "missing-install",
        state: nextState,
      };
    }
    throw err;
  }
}

/**
 * 描述网关服务重启结果
 * @param serviceNoun - 服务名词（如 "LaunchAgent"）
 * @param result - 重启结果
 * @returns 格式化的描述对象
 */
export function describeGatewayServiceRestart(
  serviceNoun: string,
  result: GatewayServiceRestartResult,
): {
  scheduled: boolean;
  daemonActionResult: "restarted" | "scheduled";
  message: string;
  progressMessage: string;
} {
  if (result.outcome === "scheduled") {
    return {
      scheduled: true,
      daemonActionResult: "scheduled",
      message: `restart scheduled, ${normalizeLowercaseStringOrEmpty(serviceNoun)} will restart momentarily`,
      progressMessage: `${serviceNoun} service restart scheduled.`,
    };
  }
  return {
    scheduled: false,
    daemonActionResult: "restarted",
    message: `${serviceNoun} service restarted.`,
    progressMessage: `${serviceNoun} service restarted.`,
  };
}

// 支持的网关服务平台类型
type SupportedGatewayGatewayServicePlatform = "darwin" | "linux" | "win32";

// 网关服务注册表，按平台分发
const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",        // macOS 使用 LaunchAgent
    loadedText: "loaded",       // 已加载文本
    notLoadedText: "not loaded", // 未加载文本
    stage: ignoreServiceWriteResult(stageLaunchAgent),        // 暂存
    install: ignoreServiceWriteResult(installLaunchAgent),    // 安装
    uninstall: uninstallLaunchAgent,                          // 卸载
    stop: stopLaunchAgent,                                    // 停止
    restart: restartLaunchAgent,                              // 重启
    isLoaded: isLaunchAgentLoaded,                           // 检查加载状态
    readCommand: readLaunchAgentProgramArguments,             // 读取命令
    readRuntime: readLaunchAgentRuntime,                     // 读取运行时
  },
  linux: {
    label: "systemd",            // Linux 使用 systemd
    loadedText: "enabled",       // 已启用文本
    notLoadedText: "disabled",   // 未启用文本
    stage: ignoreServiceWriteResult(stageSystemdService),     // 暂存
    install: ignoreServiceWriteResult(installSystemdService), // 安装
    uninstall: uninstallSystemdService,                       // 卸载
    stop: stopSystemdService,                                 // 停止
    restart: restartSystemdService,                            // 重启
    isLoaded: isSystemdServiceEnabled,                        // 检查启用状态
    readCommand: readSystemdServiceExecStart,                 // 读取启动命令
    readRuntime: readSystemdServiceRuntime,                    // 读取运行时
  },
  win32: {
    label: "Scheduled Task",     // Windows 使用计划任务
    loadedText: "registered",    // 已注册文本
    notLoadedText: "missing",    // 缺失文本
    stage: ignoreServiceWriteResult(stageScheduledTask),      // 暂存
    install: ignoreServiceWriteResult(installScheduledTask),  // 安装
    uninstall: uninstallScheduledTask,                         // 卸载
    stop: stopScheduledTask,                                  // 停止
    restart: restartScheduledTask,                             // 重启
    isLoaded: isScheduledTaskInstalled,                      // 检查安装状态
    readCommand: readScheduledTaskCommand,                    // 读取命令
    readRuntime: readScheduledTaskRuntime,                    // 读取运行时
  },
};

/**
 * 添加未来配置守卫包装服务
 * @param service - 原始服务
 * @returns 包装后的服务
 */
function withFutureConfigGuard(service: GatewayService): GatewayService {
  return {
    ...service,
    stage: async (args) => {
      // 检查是否可以重写网关服务
      await assertFutureConfigActionAllowed("rewrite the gateway service");
      return await service.stage(args);
    },
    install: async (args) => {
      await assertFutureConfigActionAllowed("install or rewrite the gateway service");
      return await service.install(args);
    },
    uninstall: async (args) => {
      await assertFutureConfigActionAllowed("uninstall the gateway service");
      return await service.uninstall(args);
    },
    stop: async (args) => {
      await assertFutureConfigActionAllowed("stop the gateway service");
      return await service.stop(args);
    },
    restart: async (args) => {
      await assertFutureConfigActionAllowed("restart the gateway service");
      return await service.restart(args);
    },
  };
}

/**
 * 检查是否为支持的平台
 * @param platform - 平台标识
 * @returns 是否支持
 */
function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is SupportedGatewayGatewayServicePlatform {
  return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}

/**
 * 解析网关服务
 * @returns 网关服务实例
 * @throws 如果平台不支持
 */
export function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return withFutureConfigGuard(GATEWAY_SERVICE_REGISTRY[process.platform]);
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
