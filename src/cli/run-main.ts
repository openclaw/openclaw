/**
 * OpenClaw CLI 主运行模块
 * 负责 CLI 的启动、参数解析、代理初始化、路由和命令执行
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue, normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import type { ProxyHandle } from "../infra/net/proxy/proxy-lifecycle.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import type { PluginManifestCommandAliasRegistry } from "../plugins/manifest-command-aliases.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  shouldRegisterPrimaryCommandOnly,
  shouldSkipPluginCommandRegistration,
} from "./command-registration-policy.js";
import { maybeRunCliInContainer, parseCliContainerArgs } from "./container-target.js";
import {
  consumeGatewayFastPathRootOptionToken,
  consumeGatewayRunOptionToken,
} from "./gateway-run-argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import {
  resolveMissingPluginCommandMessage as resolveMissingPluginCommandMessageFromPolicy,
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

// 从策略模块导出的函数，供外部使用
export {
  rewriteUpdateFlagArgv,
  shouldEnsureCliPath,
  shouldStartCrestodianForBareRoot,
  shouldStartCrestodianForModernOnboard,
  shouldStartProxyForCli,
  shouldUseBrowserHelpFastPath,
  shouldUseRootHelpFastPath,
} from "./run-main-policy.js";

/**
 * 可等待类型别名
 * 表示类型 T 或 Promise<T>
 */
type Awaitable<T> = T | Promise<T>;

/**
 * HTTP 代理环境变量键列表
 * 用于检测是否配置了代理
 */
const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

/**
 * 创建网关 CLI 启动追踪器
 * 用于记录和报告 CLI 启动过程中各阶段的耗时
 * @param argv - 命令行参数数组
 * @returns 启动追踪器对象，包含标记和测量方法
 */
function createGatewayCliMainStartupTrace(argv: string[]) {
  // 检查是否启用了网关启动追踪
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;

  /**
   * 发出追踪事件
   * @param name - 事件名称
   * @param durationMs - 持续时间（毫秒）
   * @param totalMs - 总时间（毫秒）
   */
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: cli.main.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };

  return {
    /**
     * 标记一个阶段完成
     * @param name - 阶段名称
     */
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },

    /**
     * 测量一个异步操作的耗时
     * @param name - 操作名称
     * @param run - 异步操作函数
     * @returns 操作结果
     */
    async measure<T>(name: string, run: () => Awaitable<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

/**
 * 检查参数是否是网关运行快速路径
 * 快速路径是一种优化，用于快速启动网关命令
 * @param argv - 命令行参数数组
 * @returns 是否应使用网关运行快速路径
 */
export function isGatewayRunFastPathArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);

  // 帮助或版本标志不适用快速路径
  if (invocation.hasHelpOrVersion) {
    return false;
  }

  const args = argv.slice(2);
  let sawGateway = false;
  let sawRun = false;

  // 遍历参数，查找 "gateway run" 模式
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return false;
    }

    // 处理根选项标记（消耗后继续）
    if (!sawGateway) {
      const consumed = consumeGatewayFastPathRootOptionToken(args, index);
      if (consumed > 0) {
        index += consumed - 1;
        continue;
      }
      if (arg !== "gateway") {
        return false;
      }
      sawGateway = true;
      continue;
    }

    // 处理 run 选项标记
    const consumed = consumeGatewayRunOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    return false;
  }

  return sawGateway;
}

/**
 * 检查是否存在 JSON 输出标志
 * @param argv - 命令行参数数组
 * @returns 是否存在 JSON 输出标志
 */
function hasJsonOutputFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}

/**
 * 尝试运行网关运行快速路径
 * 这是一种优化路径，用于快速启动网关命令
 * @param argv - 命令行参数数组
 * @param startupTrace - 启动追踪器
 * @returns 是否成功执行了快速路径
 */
async function tryRunGatewayRunFastPath(
  argv: string[],
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
): Promise<boolean> {
  if (!isGatewayRunFastPathArgv(argv)) {
    return false;
  }

  // 动态导入所需的模块
  const [
    { Command },
    { addGatewayRunCommand },
    { VERSION },
    { emitCliBanner },
    { resolveCliStartupPolicy },
  ] = await startupTrace.measure("gateway-run-imports", () =>
    Promise.all([
      import("commander"),
      import("./gateway-cli/run.js"),
      import("../version.js"),
      import("./banner.js"),
      import("./command-startup-policy.js"),
    ]),
  );

  const invocation = resolveCliArgvInvocation(argv);

  // 解析 CLI 启动策略
  const startupPolicy = resolveCliStartupPolicy({
    commandPath: invocation.commandPath,
    jsonOutputMode: hasJsonOutputFlag(argv),
    routeMode: true,
  });

  // 如果策略不禁止显示横幅，则输出横幅
  if (!startupPolicy.hideBanner) {
    emitCliBanner(VERSION, { argv });
  }

  // 创建 commander 程序
  const program = new Command();
  program.name("openclaw");
  program.enablePositionalOptions();
  program.option("--no-color", "Disable ANSI colors", false);
  program.exitOverride((err) => {
    process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
    throw err;
  });

  // 添加网关命令
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run, inspect, and query the WebSocket Gateway"),
  );
  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  try {
    // 解析命令行参数
    await startupTrace.measure("gateway-run-parse", () => program.parseAsync(argv));
  } catch (error) {
    // 检查是否是 commander 的解析退出错误
    if (!isCommanderParseExit(error)) {
      throw error;
    }
    process.exitCode = error.exitCode;
  }
  return true;
}

/**
 * 关闭 CLI 内存管理器
 * 执行最佳努力关闭，确保短生命周期 CLI 进程能正常清理
 */
async function closeCliMemoryManagers(): Promise<void> {
  const { hasMemoryRuntime } = await import("../plugins/memory-state.js");
  if (!hasMemoryRuntime()) {
    return;
  }
  try {
    const { closeActiveMemorySearchManagers } = await import("../plugins/memory-runtime.js");
    await closeActiveMemorySearchManagers();
  } catch {
    // 最佳努力关闭短生命周期 CLI 进程
  }
}

/**
 * 解析缺失插件命令的错误消息
 * @param pluginId - 插件标识符
 * @param config - OpenClaw 配置
 * @param options - 选项
 * @returns 错误消息，如果找不到则返回 null
 */
export function resolveMissingPluginCommandMessage(
  pluginId: string,
  config?: OpenClawConfig,
  options?: { registry?: PluginManifestCommandAliasRegistry },
): string | null {
  return resolveMissingPluginCommandMessageFromPolicy(
    pluginId,
    config,
    options?.registry ? { registry: options.registry } : undefined,
  );
}

/**
 * 检查是否应加载 CLI .env 文件
 * 检查当前工作目录或状态目录中是否存在 .env 文件
 * @param env - 进程环境变量对象
 * @returns 是否应加载 .env 文件
 */
function shouldLoadCliDotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (existsSync(path.join(process.cwd(), ".env"))) {
    return true;
  }
  return existsSync(path.join(resolveStateDir(env), ".env"));
}

/**
 * 检查错误是否是 commander 的解析退出错误
 * @param error - 错误对象
 * @returns 是否是 commander 解析退出错误
 */
function isCommanderParseExit(error: unknown): error is { exitCode: number } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; exitCode?: unknown };
  return (
    typeof candidate.exitCode === "number" &&
    Number.isInteger(candidate.exitCode) &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("commander.")
  );
}

/**
 * 确保 CLI 环境代理调度器已初始化
 * 如果检测到环境代理配置，则设置全局调度器
 */
async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // 最佳努力代理引导；CLI 启动应在没有代理的情况下继续
  }
}

/**
 * 检查是否应在快速路径之前引导 CLI 代理
 * 根据环境变量判断是否需要代理
 * @param env - 进程环境变量对象
 * @returns 是否应在快速路径之前引导代理
 */
function shouldBootstrapCliProxyBeforeFastPath(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  ) {
    return true;
  }
  return CLI_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

/**
 * 引导 CLI 代理捕获和调度器
 * 初始化调试代理捕获和全局调度器
 * @param startupTrace - 启动追踪器
 */
async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayCliMainStartupTrace>,
): Promise<void> {
  const [
    { initializeDebugProxyCapture, finalizeDebugProxyCapture },
    { maybeWarnAboutDebugProxyCoverage },
  ] = await startupTrace.measure("proxy-imports", () =>
    Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
  );
  initializeDebugProxyCapture("cli");

  // 在进程退出时最终化调试代理捕获
  process.once("exit", () => {
    finalizeDebugProxyCapture();
  });
  await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  maybeWarnAboutDebugProxyCoverage();
}

/**
 * CLI 主运行函数
 * 协调整个 CLI 启动过程，包括参数解析、容器运行、代理启动、路由和命令执行
 * @param argv - 命令行参数数组，默认为 process.argv
 */
export async function runCli(argv: string[] = process.argv) {
  // 规范化 Windows 命令行参数
  const originalArgv = normalizeWindowsArgv(argv);
  const startupTrace = createGatewayCliMainStartupTrace(originalArgv);

  // 解析容器参数
  const parsedContainer = parseCliContainerArgs(originalArgv);
  if (!parsedContainer.ok) {
    throw new Error(parsedContainer.error);
  }

  // 解析 Profile 参数
  const parsedProfile = parseCliProfileArgs(parsedContainer.argv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }

  // 应用 Profile 环境变量
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }

  // 解析容器目标名称
  const containerTargetName =
    parsedContainer.container ?? normalizeOptionalString(process.env.OPENCLAW_CONTAINER) ?? null;

  // 验证容器和 Profile 不能同时使用
  if (containerTargetName && parsedProfile.profile) {
    throw new Error("--container cannot be combined with --profile/--dev");
  }

  // 尝试在容器中运行 CLI
  const containerTarget = maybeRunCliInContainer(originalArgv);
  if (containerTarget.handled) {
    if (containerTarget.exitCode !== 0) {
      process.exitCode = containerTarget.exitCode;
    }
    return;
  }

  let normalizedArgv = parsedProfile.argv;
  startupTrace.mark("argv");

  // 加载 .env 文件
  if (shouldLoadCliDotEnv()) {
    await startupTrace.measure("dotenv", async () => {
      const { loadCliDotEnv } = await import("./dotenv.js");
      loadCliDotEnv({ quiet: true });
    });
  }

  // 规范化环境变量
  normalizeEnv();

  // 确保 CLI 路径在 PATH 中
  if (shouldEnsureCliPath(normalizedArgv)) {
    ensureOpenClawCliOnPath();
  }

  // 在做任何工作之前强制执行最低支持的运行时
  assertSupportedRuntime();

  // 激活由操作员管理的代理路由，用于网络命令
  // 本地网关/控制平面命令保持直接回环访问，
  // 而运行时、提供商、插件、更新和未知插件命令路由出口
  let proxyHandle: ProxyHandle | null = null;

  /**
   * 停止已启动的代理
   */
  const stopStartedProxy = async () => {
    const handle = proxyHandle;
    proxyHandle = null;
    if (handle) {
      const { stopProxy } = await import("../infra/net/proxy/proxy-lifecycle.js");
      await stopProxy(handle);
    }
  };

  /**
   * 杀死已启动的代理进程
   */
  const killStartedProxy = () => {
    const handle = proxyHandle;
    proxyHandle = null;
    handle?.kill("SIGTERM");
  };

  // 根据策略决定是否启动代理
  if (shouldStartProxyForCli(normalizedArgv)) {
    const [{ getRuntimeConfig }, { startProxy }] = await Promise.all([
      import("../config/io.js"),
      import("../infra/net/proxy/proxy-lifecycle.js"),
    ]);
    const config = getRuntimeConfig();
    proxyHandle = await startProxy(config?.proxy ?? undefined);
  }

  let onSigterm: (() => void) | null = null;
  let onSigint: (() => void) | null = null;
  let onExit: (() => void) | null = null;

  // 如果有代理句柄，设置信号处理器
  if (proxyHandle) {
    const shutdown = (exitCode: number) => {
      if (onSigterm) {
        process.off("SIGTERM", onSigterm);
      }
      if (onSigint) {
        process.off("SIGINT", onSigint);
      }
      void stopStartedProxy().finally(() => {
        process.exit(exitCode);
      });
    };
    onSigterm = () => shutdown(143);
    onSigint = () => shutdown(130);
    onExit = () => killStartedProxy();
    process.once("SIGTERM", onSigterm);
    process.once("SIGINT", onSigint);
    process.once("exit", onExit);
  }

  try {
    // 检查是否使用根帮助快速路径
    if (shouldUseRootHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedRootHelpText } = await import("./root-help-metadata.js");
      if (!outputPrecomputedRootHelpText()) {
        const { outputRootHelp } = await import("./program/root-help.js");
        await outputRootHelp();
      }
      return;
    }

    // 检查是否使用浏览器帮助快速路径
    if (shouldUseBrowserHelpFastPath(normalizedArgv)) {
      const { outputPrecomputedBrowserHelpText } = await import("./root-help-metadata.js");
      if (outputPrecomputedBrowserHelpText()) {
        return;
      }
    }

    // 检查是否应运行看门狗（crestodian）
    const shouldRunBareRootCrestodian = shouldStartCrestodianForBareRoot(normalizedArgv);
    const shouldRunModernOnboardCrestodian = shouldStartCrestodianForModernOnboard(normalizedArgv);
    if (shouldRunBareRootCrestodian || shouldRunModernOnboardCrestodian) {
      await ensureCliEnvProxyDispatcher();
    }

    // 运行裸根看门狗
    if (shouldRunBareRootCrestodian) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          'Crestodian needs an interactive TTY. Use `openclaw crestodian --message "status"` for one command.',
        );
        process.exitCode = 1;
        return;
      }
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      const { createCliProgress } = await import("./progress.js");
      const progress = createCliProgress({
        label: "Starting Crestodian…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      });
      let progressStopped = false;
      const stopProgress = () => {
        if (progressStopped) {
          return;
        }
        progressStopped = true;
        progress.done();
      };
      try {
        await runCrestodian({ onReady: stopProgress });
      } finally {
        stopProgress();
      }
      return;
    }

    // 运行现代 onboard 看门狗
    if (shouldRunModernOnboardCrestodian) {
      const { runCrestodian } = await import("../crestodian/crestodian.js");
      const nonInteractive = normalizedArgv.includes("--non-interactive");
      await runCrestodian({
        message: nonInteractive ? "overview" : undefined,
        yes: false,
        json: normalizedArgv.includes("--json"),
        interactive: !nonInteractive,
      });
      return;
    }

    // 检查是否应在快速路径之前引导代理
    const bootstrapProxyBeforeFastPath = shouldBootstrapCliProxyBeforeFastPath();
    if (
      !bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    // 引导 CLI 代理捕获和调度器
    await bootstrapCliProxyCaptureAndDispatcher(startupTrace);

    // 再次尝试网关快速路径
    if (
      bootstrapProxyBeforeFastPath &&
      (await tryRunGatewayRunFastPath(normalizedArgv, startupTrace))
    ) {
      return;
    }

    // 尝试路由 CLI 命令
    const { tryRouteCli } = await startupTrace.measure("route-import", () => import("./route.js"));
    if (await startupTrace.measure("route", () => tryRouteCli(normalizedArgv))) {
      return;
    }

    // 创建启动进度指示器
    const { createCliProgress } = await import("./progress.js");
    const startupProgress = createCliProgress({
      label: "Loading OpenClaw CLI…",
      indeterminate: true,
      delayMs: 0,
      fallback: "none",
    });
    let startupProgressStopped = false;
    const stopStartupProgress = () => {
      if (startupProgressStopped) {
        return;
      }
      startupProgressStopped = true;
      startupProgress.done();
    };

    try {
      // 启用控制台输出捕获到结构化日志，同时保持 stdout/stderr 行为
      const { enableConsoleCapture } = await import("../logging.js");
      enableConsoleCapture();

      // 动态导入核心模块
      const [
        { buildProgram },
        { formatUncaughtError },
        { runFatalErrorHooks },
        {
          installUnhandledRejectionHandler,
          isBenignUncaughtExceptionError,
          isUncaughtExceptionHandled,
        },
        { restoreTerminalState },
      ] = await startupTrace.measure("core-imports", () =>
        Promise.all([
          import("./program.js"),
          import("../infra/errors.js"),
          import("../infra/fatal-error-hooks.js"),
          import("../infra/unhandled-rejections.js"),
          import("../terminal/restore.js"),
        ]),
      );

      // 构建程序
      const program = await startupTrace.measure("build-program", () => buildProgram());

      // 安装全局错误处理器，防止未处理拒绝/异常导致静默崩溃
      installUnhandledRejectionHandler();

      // 未捕获异常处理器
      process.on("uncaughtException", (error) => {
        if (isUncaughtExceptionHandled(error)) {
          return;
        }
        if (isBenignUncaughtExceptionError(error)) {
          console.warn(
            "[openclaw] Non-fatal uncaught exception (continuing):",
            formatUncaughtError(error),
          );
          return;
        }
        console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
        for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
          console.error("[openclaw]", message);
        }
        restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
        process.exit(1);
      });

      // 重写更新标志参数
      const parseArgv = rewriteUpdateFlagArgv(normalizedArgv);
      const invocation = resolveCliArgvInvocation(parseArgv);

      // 注册主命令（内置或子 CLI），以确保即使使用懒命令注册，帮助和命令解析也是正确的
      const { primary } = invocation;
      if (primary && shouldRegisterPrimaryCommandOnly(parseArgv)) {
        await startupTrace.measure("register-primary", async () => {
          const { getProgramContext } = await import("./program/program-context.js");
          const ctx = getProgramContext(program);
          if (ctx) {
            const { registerCoreCliByName } = await import("./program/command-registry.js");
            await registerCoreCliByName(program, ctx, primary, parseArgv);
          }
          const { registerSubCliByName } = await import("./program/register.subclis.js");
          await registerSubCliByName(program, primary, parseArgv);
        });
      }

      // 检查主命令是否是内置命令
      const hasBuiltinPrimary =
        primary !== null &&
        program.commands.some(
          (command) => command.name() === primary || command.aliases().includes(primary),
        );

      // 检查是否应跳过插件命令注册
      const shouldSkipPluginRegistration = shouldSkipPluginCommandRegistration({
        argv: parseArgv,
        primary,
        hasBuiltinPrimary,
      });

      // 注册插件 CLI 命令
      if (!shouldSkipPluginRegistration) {
        const config = await startupTrace.measure("register-plugin-commands", async () => {
          const { registerPluginCliCommandsFromValidatedConfig } =
            await import("../plugins/cli.js");
          return await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            mode: "lazy",
            primary,
          });
        });

        // 如果主命令是缺失的插件命令，报错
        if (config) {
          if (
            primary &&
            !program.commands.some(
              (command) => command.name() === primary || command.aliases().includes(primary),
            )
          ) {
            const { resolveManifestCommandAliasOwner } =
              await import("../plugins/manifest-command-aliases.runtime.js");
            const missingPluginCommandMessage = resolveMissingPluginCommandMessageFromPolicy(
              primary,
              config,
              {
                resolveCommandAliasOwner: resolveManifestCommandAliasOwner,
              },
            );
            if (missingPluginCommandMessage) {
              throw new Error(missingPluginCommandMessage);
            }
          }
        }
      }

      // 停止启动进度
      stopStartupProgress();

      // 解析命令行参数
      try {
        await startupTrace.measure("parse", () => program.parseAsync(parseArgv));
      } catch (error) {
        if (!isCommanderParseExit(error)) {
          throw error;
        }
        process.exitCode = error.exitCode;
      }
    } finally {
      stopStartupProgress();
    }
  } finally {
    // 清理信号处理器和代理
    if (onSigterm) {
      process.off("SIGTERM", onSigterm);
    }
    if (onSigint) {
      process.off("SIGINT", onSigint);
    }
    if (onExit) {
      process.off("exit", onExit);
    }
    await stopStartedProxy();
    await closeCliMemoryManagers();
  }
}

/**
 * 检查当前模块是否为主模块
 * @returns 是否为主模块
 */
export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
