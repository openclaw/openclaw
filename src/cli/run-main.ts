// CLI 主入口模块 - 命令行接口的核心启动和路由逻辑 / CLI main entry module - core startup and routing logic for command line interface

import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeEnv } from "../infra/env.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { enableConsoleCapture } from "../logging.js";
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  hasHelpOrVersion,
  isRootHelpInvocation,
} from "./argv.js";
import { loadCliDotEnv } from "./dotenv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { normalizeArgs } from "./program/command-aliases.js";
import { tryRouteCli } from "./route.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

/**
 * 关闭 CLI 内存管理器 / Close CLI memory managers
 * 在 CLI 进程退出前清理内存搜索管理器 / Cleans up memory search managers before CLI process exits
 */
async function closeCliMemoryManagers(): Promise<void> {
  try {
    const { closeAllMemorySearchManagers } = await import("../memory/search-manager.js");
    await closeAllMemorySearchManagers();
  } catch {
    // 最佳努力的清理，短生命周期的 CLI 进程可能不需要 / Best-effort teardown for short-lived CLI processes
  }
}

/**
 * 重写更新标志参数 / Rewrite update flag arguments
 * 将 --update 标志转换为 update 子命令 / Converts --update flag to update subcommand
 * @param argv - 原始参数数组 / Original argument array
 * @returns 重写后的参数数组 / Rewritten argument array
 */
export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

/**
 * 判断是否应注册主子命令 / Determine if primary subcommand should be registered
 * @param argv - 命令行参数数组 / Command line argument array
 * @returns 是否应注册主子命令 / Whether to register primary subcommand
 */
export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

/**
 * 判断是否应跳过插件命令注册 / Determine if plugin command registration should be skipped
 * @param params - 参数对象 / Parameter object
 * @returns 是否应跳过 / Whether to skip
 */
export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  // 如果有内置主命令，跳过插件注册 / Skip plugin registration if there's a built-in primary command
  if (params.hasBuiltinPrimary) {
    return true;
  }
  // 如果没有主命令，检查是否有帮助或版本标志 / If no primary command, check for help or version flags
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

/**
 * 判断是否应确保 CLI 在路径中 / Determine if CLI should be ensured on PATH
 * @param argv - 命令行参数数组 / Command line argument array
 * @returns 是否应确保 / Whether to ensure
 */
export function shouldEnsureCliPath(argv: string[]): boolean {
  // 帮助和版本命令不需要 / Help and version commands don't need it
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
  // 无主命令时需要 / Need it when no primary command
  if (!primary) {
    return true;
  }
  // 状态、健康检查、会话命令不需要 / Status, health, sessions commands don't need it
  if (primary === "status" || primary === "health" || primary === "sessions") {
    return false;
  }
  // 配置的 get 和 unset 子命令不需要 / Config get and unset subcommands don't need it
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  // 模型的 list 和 status 子命令不需要 / Models list and status subcommands don't need it
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  return true;
}

/**
 * 判断是否应使用根帮助快速路径 / Determine if root help fast path should be used
 * @param argv - 命令行参数数组 / Command line argument array
 * @returns 是否应使用快速路径 / Whether to use fast path
 */
export function shouldUseRootHelpFastPath(argv: string[]): boolean {
  return isRootHelpInvocation(argv);
}

/**
 * 运行 CLI 主函数 / Run CLI main function
 * CLI 的主要入口点，负责解析参数、加载配置、注册命令和执行程序
 * Main entry point for CLI, responsible for parsing arguments, loading config, registering commands and executing program
 *
 * @param argv - 命令行参数数组，默认为 process.argv / Command line argument array, defaults to process.argv
 */
export async function runCli(argv: string[] = process.argv) {
  // 规范化 Windows 参数 / Normalize Windows arguments
  let normalizedArgv = normalizeWindowsArgv(argv);

  // 解析 CLI 配置文件参数 / Parse CLI profile arguments
  const parsedProfile = parseCliProfileArgs(normalizedArgv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }

  // 应用配置文件环境变量 / Apply profile environment variables
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  normalizedArgv = parsedProfile.argv;

  // 应用命令别名规范化（中英文命令转换）/ Apply command alias normalization (Chinese-English command conversion)
  normalizedArgv = normalizeArgs(normalizedArgv);

  // 加载 .env 文件 / Load .env file
  loadCliDotEnv({ quiet: true });

  // 规范化环境变量 / Normalize environment variables
  normalizeEnv();

  // 确保 openclaw 命令在 PATH 中 / Ensure openclaw command is on PATH
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // 在执行任何工作之前，强制执行最低支持的运行时 / Enforce the minimum supported runtime before doing any work
  assertSupportedRuntime();

  try {
    // 使用根帮助快速路径 / Use root help fast path
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputRootHelp } = await import("./program/root-help.js");
      outputRootHelp();
      return;
    }

    // 尝试路由 CLI 到特定处理器 / Try to route CLI to specific handler
    if (await tryRouteCli(normalizedArgv)) {
      return;
    }

    // 捕获所有控制台输出到结构化日志，同时保持 stdout/stderr 行为
    // Capture all console output into structured logs while keeping stdout/stderr behavior
    enableConsoleCapture();

    // 构建命令行程序 / Build command line program
    const { buildProgram } = await import("./program.js");
    const program = buildProgram();

    // 安装未处理拒绝处理器 / Install unhandled rejection handler
    const { installUnhandledRejectionHandler } = await import("../infra/unhandled-rejections.js");

    // 全局错误处理器，防止未处理的拒绝/异常导致静默崩溃
    // Global error handlers to prevent silent crashes from unhandled rejections/exceptions
    // 这些处理器会记录错误并优雅退出，而不是无痕迹地崩溃
    // These log the error and exit gracefully instead of crashing without trace
    installUnhandledRejectionHandler();

    // 未捕获异常处理器 / Uncaught exception handler
    process.on("uncaughtException", (error) => {
      console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
      process.exit(1);
    });

    // 重写更新标志参数 / Rewrite update flag arguments
    const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);

    // 注册主命令（内置或子 CLI），以便即使在延迟命令注册的情况下，帮助和命令解析也是正确的
    // Register the primary command (builtin or subcli) so help and command parsing are correct even with lazy command registration
    const primary = getPrimaryCommand(parseArgv);
    if (primary) {
      const { getProgramContext } = await import("./program/program-context.js");
      const ctx = getProgramContext(program);
      if (ctx) {
        const { registerCoreCliByName } = await import("./program/command-registry.js");
        await registerCoreCliByName(program, ctx, primary, parseArgv);
      }
      const { registerSubCliByName } = await import("./program/register.subclis.js");
      await registerSubCliByName(program, primary);
    }

    // 检查是否有内置主命令 / Check if there's a built-in primary command
    const hasBuiltinPrimary =
      primary !== null && program.commands.some((command) => command.name() === primary);

    // 判断是否应跳过插件注册 / Determine if plugin registration should be skipped
    const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
      argv: parseArgv,
      primary,
      hasBuiltinPrimary,
    });

    if (!shouldSkipPluginRegistration) {
      // 在解析之前注册插件 CLI 命令 / Register plugin CLI commands before parsing
      const { registerPluginCliCommands } = await import("../plugins/cli.js");
      const { loadValidatedConfigForPluginRegistration } =
        await import("./program/register.subclis.js");
      const config = await loadValidatedConfigForPluginRegistration();
      if (config) {
        registerPluginCliCommands(program, config);
      }
    }

    // 解析并执行命令 / Parse and execute command
    await program.parseAsync(parseArgv);
  } finally {
    // 清理内存管理器 / Clean up memory managers
    await closeCliMemoryManagers();
  }
}

/**
 * 判断是否为 CLI 主模块 / Determine if this is the CLI main module
 * @returns 是否为主模块 / Whether this is the main module
 */
export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
