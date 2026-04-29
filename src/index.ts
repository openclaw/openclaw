#!/usr/bin/env node
// Shebang 行，指定使用 Node.js 解释器执行脚本
import process from "node:process";
// 导入 Node.js 的 process 对象，用于访问进程信息和环境变量
import { fileURLToPath } from "node:url";
// 导入 fileURLToPath 函数，用于将文件 URL 转换为文件路径
import { formatUncaughtError } from "./infra/errors.js";
// 导入格式化未捕获错误的函数
import { runFatalErrorHooks } from "./infra/fatal-error-hooks.js";
// 导入运行致命错误钩子的函数
import { isMainModule } from "./infra/is-main.js";
// 导入主模块判断函数
import {
  installUnhandledRejectionHandler,
  isBenignUncaughtExceptionError,
  isUncaughtExceptionHandled,
} from "./infra/unhandled-rejections.js";
// 导入未处理拒绝/异常处理相关函数

// 定义遗留 CLI 依赖的类型
type LegacyCliDeps = {
  runCli: (argv: string[]) => Promise<void>;
};

// 定义库导出类型，用于类型推断
type LibraryExports = typeof import("./library.js");

// 以下绑定仅为库使用者填充。CLI 入口保持在精简路径上
// 作为 main 运行时不得读取这些绑定

// 导出 applyTemplate 函数
export let applyTemplate: LibraryExports["applyTemplate"];
// 导出创建默认依赖的函数
export let createDefaultDeps: LibraryExports["createDefaultDeps"];
// 导出推导会话密钥的函数
export let deriveSessionKey: LibraryExports["deriveSessionKey"];
// 导出描述端口所有者的函数
export let describePortOwner: LibraryExports["describePortOwner"];
// 导出确保二进制文件存在的函数
export let ensureBinary: LibraryExports["ensureBinary"];
// 导出确保端口可用的函数
export let ensurePortAvailable: LibraryExports["ensurePortAvailable"];
// 导出从配置获取回复的函数
export let getReplyFromConfig: LibraryExports["getReplyFromConfig"];
// 导出处理端口错误的函数
export let handlePortError: LibraryExports["handlePortError"];
// 导出加载配置的函数
export let loadConfig: LibraryExports["loadConfig"];
// 导出加载会话存储的函数
export let loadSessionStore: LibraryExports["loadSessionStore"];
// 导出监控 Web 频道的函数
export let monitorWebChannel: LibraryExports["monitorWebChannel"];
// 导出标准化 E164 电话号码格式的函数
export let normalizeE164: LibraryExports["normalizeE164"];
// 导出端口占用错误类
export let PortInUseError: LibraryExports["PortInUseError"];
// 导出是/否提示函数
export let promptYesNo: LibraryExports["promptYesNo"];
// 导出解析会话密钥的函数
export let resolveSessionKey: LibraryExports["resolveSessionKey"];
// 导出解析存储路径的函数
export let resolveStorePath: LibraryExports["resolveStorePath"];
// 导出带超时运行命令的函数
export let runCommandWithTimeout: LibraryExports["runCommandWithTimeout"];
// 导出执行命令的函数
export let runExec: LibraryExports["runExec"];
// 导出保存会话存储的函数
export let saveSessionStore: LibraryExports["saveSessionStore"];
// 导出永久等待函数
export let waitForever: LibraryExports["waitForever"];

// 异步加载遗留 CLI 依赖
async function loadLegacyCliDeps(): Promise<LegacyCliDeps> {
  // 动态导入 run-main.js 中的 runCli 函数
  const { runCli } = await import("./cli/run-main.js");
  return { runCli };
}

// 遗留的直接文件入口点仅用于兼容。包根导出现在位于 library.ts 中
// 导出遗留 CLI 入口函数
export async function runLegacyCliEntry(
  argv: string[] = process.argv, // 默认使用进程参数
  deps?: LegacyCliDeps, // 可选的依赖项
): Promise<void> {
  // 使用提供的依赖或动态加载
  const { runCli } = deps ?? (await loadLegacyCliDeps());
  await runCli(argv);
}

// 判断当前文件是否为主模块
const isMain = isMainModule({
  currentFile: fileURLToPath(import.meta.url),
});

// 如果不是主模块，则从 library.js 导入所有库导出
if (!isMain) {
  ({
    applyTemplate,
    createDefaultDeps,
    deriveSessionKey,
    describePortOwner,
    ensureBinary,
    ensurePortAvailable,
    getReplyFromConfig,
    handlePortError,
    loadConfig,
    loadSessionStore,
    monitorWebChannel,
    normalizeE164,
    PortInUseError,
    promptYesNo,
    resolveSessionKey,
    resolveStorePath,
    runCommandWithTimeout,
    runExec,
    saveSessionStore,
    waitForever,
  } = await import("./library.js"));
}

// 如果是主模块，设置错误处理和执行 CLI
if (isMain) {
  // 导入恢复终端状态的函数
  const { restoreTerminalState } = await import("./terminal/restore.js");

  // 全局错误处理器，防止未处理的拒绝/异常导致静默崩溃
  // 这些处理器会记录错误并优雅退出，而不是无跟踪地崩溃
  installUnhandledRejectionHandler();

  // 监听未捕获的异常
  process.on("uncaughtException", (error) => {
    // 如果异常已被处理，则返回
    if (isUncaughtExceptionHandled(error)) {
      return;
    }
    // 如果是良性异常，继续运行但输出警告
    if (isBenignUncaughtExceptionError(error)) {
      console.warn(
        "[openclaw] Non-fatal uncaught exception (continuing):",
        formatUncaughtError(error),
      );
      return;
    }
    // 输出致命异常错误
    console.error("[openclaw] Uncaught exception:", formatUncaughtError(error));
    // 运行致命错误钩子
    for (const message of runFatalErrorHooks({ reason: "uncaught_exception", error })) {
      console.error("[openclaw]", message);
    }
    // 恢复终端状态并退出
    restoreTerminalState("uncaught exception", { resumeStdinIfPaused: false });
    process.exit(1);
  });

  // 运行遗留 CLI 入口，并捕获失败
  void runLegacyCliEntry(process.argv).catch((err) => {
    console.error("[openclaw] CLI failed:", formatUncaughtError(err));
    // 运行致命错误钩子
    for (const message of runFatalErrorHooks({ reason: "legacy_cli_failure", error: err })) {
      console.error("[openclaw]", message);
    }
    // 恢复终端状态并退出
    restoreTerminalState("legacy cli failure", { resumeStdinIfPaused: false });
    process.exit(1);
  });
}
