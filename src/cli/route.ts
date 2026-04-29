import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
  resolveCliExecutionStartupContext,
} from "./command-execution-startup.js";
import { findRoutedCommand } from "./program/routes.js";

/**
 * 准备路由命令执行的参数
 * 解析启动策略、加载插件并初始化运行时环境
 * @param params - 路由命令参数
 * @param params.argv - 命令行参数数组
 * @param params.commandPath - 命令路径数组
 * @param params.loadPlugins - 是否加载插件，可为布尔值或函数
 */
async function prepareRoutedCommand(params: {
  argv: string[];
  commandPath: string[];
  loadPlugins?: boolean | ((argv: string[]) => boolean);
}) {
  // 解析 CLI 执行启动上下文，获取启动策略配置
  const { startupPolicy } = resolveCliExecutionStartupContext({
    argv: params.argv,
    jsonOutputMode: hasFlag(params.argv, "--json"),
    env: process.env,
    routeMode: true,
  });

  // 动态导入版本信息
  const { VERSION } = await import("../version.js");

  // 应用 CLI 执行启动展示配置（横幅、进度等）
  await applyCliExecutionStartupPresentation({
    argv: params.argv,
    startupPolicy,
    showBanner: process.stdout.isTTY && !startupPolicy.suppressDoctorStdout,
    version: VERSION,
  });

  // 确定是否应加载插件（支持函数形式动态判断）
  const shouldLoadPlugins =
    typeof params.loadPlugins === "function" ? params.loadPlugins(params.argv) : params.loadPlugins;

  // 确保 CLI 执行引导程序已初始化
  await ensureCliExecutionBootstrap({
    runtime: defaultRuntime,
    commandPath: params.commandPath,
    startupPolicy,
    loadPlugins: shouldLoadPlugins ?? startupPolicy.loadPlugins,
  });
}

/**
 * 尝试将 CLI 参数路由到预定义的路由命令
 * 如果找到匹配的路由命令则执行并返回 true，否则返回 false
 * @param argv - 命令行参数数组
 * @returns 是否成功路由并执行了命令
 */
export async function tryRouteCli(argv: string[]): Promise<boolean> {
  // 检查是否禁用了路由优先模式
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }

  // 解析 CLI 参数调用信息
  const invocation = resolveCliArgvInvocation(argv);

  // 如果包含帮助或版本标志，不进行路由（由 commander 处理）
  if (invocation.hasHelpOrVersion) {
    return false;
  }

  // 确保命令路径有效
  if (!invocation.commandPath[0]) {
    return false;
  }

  // 在路由表中查找匹配的命令
  const route = findRoutedCommand(invocation.commandPath, argv);
  if (!route) {
    return false;
  }

  // 如果路由有 canRun 检查，执行它
  if (route.canRun && !route.canRun(argv)) {
    return false;
  }

  // 准备路由命令执行环境
  await prepareRoutedCommand({
    argv,
    commandPath: invocation.commandPath,
    loadPlugins: route.loadPlugins,
  });

  // 执行路由命令并返回结果
  return route.run(argv);
}
