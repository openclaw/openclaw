#!/usr/bin/env node
// Shebang 行，指定使用 Node.js 解释器执行脚本
import { spawn } from "node:child_process";
// 导入 child_process 模块的 spawn 函数，用于创建子进程
import process from "node:process";
// 导入 Node.js 的 process 对象，用于访问进程信息和环境变量
import { fileURLToPath } from "node:url";
// 导入 fileURLToPath 函数，用于将文件 URL 转换为文件路径
import { isRootHelpInvocation } from "./cli/argv.js";
// 导入命令行参数处理相关函数
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
// 导入容器目标解析相关函数
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
// 导入 CLI Profile 环境配置相关函数
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
// 导入 Windows 命令行参数规范化函数
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
// 导入 OpenClaw 编译缓存相关函数
import { buildCliRespawnPlan } from "./entry.respawn.js";
// 导入 CLI 重生计划构建函数
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
// 导入版本快速路径处理函数
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
// 导入环境变量处理相关函数
import { isMainModule } from "./infra/is-main.js";
// 导入主模块判断函数
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
// 导入进程执行标记确保函数
import { installProcessWarningFilter } from "./infra/warning-filter.js";
// 导入进程警告过滤器安装函数
import { attachChildProcessBridge } from "./process/child-process-bridge.js";
// 导入子进程桥接函数

// 定义入口文件包装器配对列表，用于判断是否为入口点
const ENTRY_WRAPPER_PAIRS = [
  // openclaw.mjs 包装器对应 entry.js 入口
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  // openclaw.js 包装器对应 entry.js 入口
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

// 判断是否应强制使用只读认证存储
function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  // 从命令行参数中提取非标志的 token（长度大于0且不以-开头）
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  // 遍历 token 数组，查找 "secrets audit" 命令组合
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

// 创建网关入口启动追踪器
function createGatewayEntryStartupTrace(argv: string[]) {
  // 根据环境变量和命令行参数判断是否启用追踪
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  // 记录启动开始时间
  const started = performance.now();
  let last = started;
  // 定义 emit 函数，用于输出追踪信息
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: entry.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  // 返回追踪器对象
  return {
    // 标记一个时间点
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    // 测量异步操作的执行时间
    async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
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

// 创建网关入口启动追踪器实例
const gatewayEntryStartupTrace = createGatewayEntryStartupTrace(process.argv);

// 守卫：仅当此文件是主模块时才运行入口点逻辑
// 当 dist/index.js 作为实际入口点时，打包器可能将 entry.js 作为共享依赖导入
// 没有此守卫，下方的顶层代码会第二次调用 runCli，启动重复的网关导致锁/端口冲突和进程崩溃
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  // 作为依赖导入时 - 跳过所有入口点副作用
} else {
  // 获取当前入口文件的绝对路径
  const entryFile = fileURLToPath(import.meta.url);
  // 解析安装根目录
  const installRoot = resolveEntryInstallRoot(entryFile);
  // 必要时在禁用 OpenClaw 编译缓存的情况下重新生成进程
  respawnWithoutOpenClawCompileCacheIfNeeded({
    currentFile: entryFile,
    installRoot,
  });
  // 设置进程标题为 openclaw
  process.title = "openclaw";
  // 确保进程上设置了 OpenClaw 执行标记
  ensureOpenClawExecMarkerOnProcess();
  // 安装进程警告过滤器
  installProcessWarningFilter();
  // 规范化环境变量
  normalizeEnv();
  // 启用 OpenClaw 编译缓存
  enableOpenClawCompileCache({
    installRoot,
  });
  // 标记引导阶段完成
  gatewayEntryStartupTrace.mark("bootstrap");

  // 如果是 secrets audit 命令，强制使用只读认证存储
  if (shouldForceReadOnlyAuthStore(process.argv)) {
    process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
  }

  // 处理 --no-color 标志，禁用颜色输出
  if (process.argv.includes("--no-color")) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }

  // 确保 CLI 重生准备就绪
  function ensureCliRespawnReady(): boolean {
    // 构建 CLI 重生计划
    const plan = buildCliRespawnPlan();
    if (!plan) {
      return false;
    }

    // 使用指定的命令和参数生成子进程
    const child = spawn(plan.command, plan.argv, {
      stdio: "inherit", // 继承父进程的标准输入输出
      env: plan.env, // 使用计划中指定的环境变量
    });

    // 附加子进程桥接器
    attachChildProcessBridge(child);

    // 监听子进程退出事件
    child.once("exit", (code, signal) => {
      if (signal) {
        // 如果是被信号终止，设置退出码为1
        process.exitCode = 1;
        return;
      }
      // 使用子进程的退出码或默认1
      process.exit(code ?? 1);
    });

    // 监听子进程错误事件
    child.once("error", (error) => {
      console.error(
        "[openclaw] Failed to respawn CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exit(1);
    });

    // 父进程必须停止运行 CLI
    return true;
  }

  // 规范化 Windows 命令行参数
  process.argv = normalizeWindowsArgv(process.argv);

  // 如果 CLI 重生未准备就绪，则解析并运行主命令
  if (!ensureCliRespawnReady()) {
    // 解析 CLI 容器参数
    const parsedContainer = parseCliContainerArgs(process.argv);
    if (!parsedContainer.ok) {
      console.error(`[openclaw] ${parsedContainer.error}`);
      process.exit(2);
    }

    // 解析 CLI Profile 参数
    const parsed = parseCliProfileArgs(parsedContainer.argv);
    if (!parsed.ok) {
      // 保持简单；Commander 会在我们剥离标志后处理丰富的帮助/错误
      console.error(`[openclaw] ${parsed.error}`);
      process.exit(2);
    }

    // 解析容器目标名称
    const containerTargetName = resolveCliContainerTarget(process.argv);
    // 如果同时指定了容器和 Profile，输出错误
    if (containerTargetName && parsed.profile) {
      console.error("[openclaw] --container cannot be combined with --profile/--dev");
      process.exit(2);
    }

    // 如果指定了 Profile，应用其环境配置
    if (parsed.profile) {
      applyCliProfileEnv({ profile: parsed.profile });
      // 保持 Commander 和临时 argv 检查的一致性
      process.argv = parsed.argv;
    }
    // 标记 argv 解析完成
    gatewayEntryStartupTrace.mark("argv");

    // 尝试处理根版本快速路径，否则运行主程序或帮助
    if (!tryHandleRootVersionFastPath(process.argv)) {
      await runMainOrRootHelp(process.argv);
    }
  }
}

// 尝试处理根帮助快速路径
export async function tryHandleRootHelpFastPath(
  argv: string[], // 命令行参数数组
  deps: { // 依赖项
    outputPrecomputedRootHelpText?: () => boolean;
    outputRootHelp?: () => void | Promise<void>;
    onError?: (error: unknown) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  // 如果存在容器目标，不处理快速路径
  if (resolveCliContainerTarget(argv, deps.env)) {
    return false;
  }
  // 如果不是根帮助调用，不处理
  if (!isRootHelpInvocation(argv)) {
    return false;
  }
  // 设置错误处理函数
  const handleError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to display help:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  try {
    // 如果有自定义的输出根帮助函数，调用它
    if (deps.outputRootHelp) {
      await deps.outputRootHelp();
      return true;
    }
    // 获取预计算的根帮助文本的输出函数
    const outputPrecomputedRootHelpText =
      deps.outputPrecomputedRootHelpText ??
      (await import("./cli/root-help-metadata.js")).outputPrecomputedRootHelpText;
    // 尝试输出预计算的帮助文本
    if (!outputPrecomputedRootHelpText()) {
      // 如果没有预计算文本，动态导入并输出帮助
      const { outputRootHelp } = await import("./cli/program/root-help.js");
      await outputRootHelp();
    }
    return true;
  } catch (error) {
    // 处理错误
    handleError(error);
    return true;
  }
}

// 运行主程序或根帮助
async function runMainOrRootHelp(argv: string[]): Promise<void> {
  // 尝试处理根帮助快速路径
  if (await tryHandleRootHelpFastPath(argv)) {
    return;
  }
  try {
    // 导入并运行 CLI 主模块
    const { runCli } = await gatewayEntryStartupTrace.measure(
      "run-main-import",
      () => import("./cli/run-main.js"),
    );
    await runCli(argv);
  } catch (error) {
    // 输出启动失败错误信息
    console.error(
      "[openclaw] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  }
}
