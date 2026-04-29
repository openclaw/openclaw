import type { getReplyFromConfig as getReplyFromConfigRuntime } from "./auto-reply/reply.runtime.js";
// 导入自动回复运行时类型，用于类型定义
import { applyTemplate } from "./auto-reply/templating.js";
// 导入模板应用函数
import { createDefaultDeps } from "./cli/deps.js";
// 导入创建默认依赖的函数
import type { promptYesNo as promptYesNoRuntime } from "./cli/prompt.js";
// 导入提示是/否运行时类型
import { waitForever } from "./cli/wait.js";
// 导入永久等待函数
import { loadConfig } from "./config/config.js";
// 导入加载配置的函数
import { resolveStorePath } from "./config/sessions/paths.js";
// 导入解析存储路径的函数
import { deriveSessionKey, resolveSessionKey } from "./config/sessions/session-key.js";
// 导入会话密钥相关函数
import { loadSessionStore, saveSessionStore } from "./config/sessions/store.js";
// 导入会话存储加载和保存函数
import type { ensureBinary as ensureBinaryRuntime } from "./infra/binaries.js";
// 导入确保二进制文件存在的运行时类型
import {
  describePortOwner,
  ensurePortAvailable,
  handlePortError,
  PortInUseError,
} from "./infra/ports.js";
// 导入端口相关函数和错误类
import type { monitorWebChannel as monitorWebChannelRuntime } from "./plugins/runtime/runtime-web-channel-plugin.js";
// 导入监控 Web 频道的运行时类型
import type {
  runCommandWithTimeout as runCommandWithTimeoutRuntime,
  runExec as runExecRuntime,
} from "./process/exec.js";
// 导入执行命令的运行时类型
import { normalizeE164 } from "./utils.js";
// 导入 E164 电话号码标准化函数

// 定义 GetReplyFromConfig 类型
type GetReplyFromConfig = typeof getReplyFromConfigRuntime;
// 定义 PromptYesNo 类型
type PromptYesNo = typeof promptYesNoRuntime;
// 定义 EnsureBinary 类型
type EnsureBinary = typeof ensureBinaryRuntime;
// 定义 RunExec 类型
type RunExec = typeof runExecRuntime;
// 定义 RunCommandWithTimeout 类型
type RunCommandWithTimeout = typeof runCommandWithTimeoutRuntime;
// 定义 MonitorWebChannel 类型
type MonitorWebChannel = typeof monitorWebChannelRuntime;

// 延迟加载回复运行时的 Promise 缓存
let replyRuntimePromise: Promise<typeof import("./auto-reply/reply.runtime.js")> | null = null;
// 延迟加载提示运行时的 Promise 缓存
let promptRuntimePromise: Promise<typeof import("./cli/prompt.js")> | null = null;
// 延迟加载二进制文件运行时的 Promise 缓存
let binariesRuntimePromise: Promise<typeof import("./infra/binaries.js")> | null = null;
// 延迟加载执行运行时的 Promise 缓存
let execRuntimePromise: Promise<typeof import("./process/exec.js")> | null = null;
// 延迟加载 Web 频道运行时的 Promise 缓存
let webChannelRuntimePromise: Promise<
  typeof import("./plugins/runtime/runtime-web-channel-plugin.js")
> | null = null;

// 加载回复运行时模块
function loadReplyRuntime() {
  // 使用空值合并赋值符缓存 Promise，避免重复加载
  replyRuntimePromise ??= import("./auto-reply/reply.runtime.js");
  return replyRuntimePromise;
}

// 加载提示运行时模块
function loadPromptRuntime() {
  promptRuntimePromise ??= import("./cli/prompt.js");
  return promptRuntimePromise;
}

// 加载二进制文件运行时模块
function loadBinariesRuntime() {
  binariesRuntimePromise ??= import("./infra/binaries.js");
  return binariesRuntimePromise;
}

// 加载执行运行时模块
function loadExecRuntime() {
  execRuntimePromise ??= import("./process/exec.js");
  return execRuntimePromise;
}

// 加载 Web 频道运行时模块
function loadWebChannelRuntime() {
  webChannelRuntimePromise ??= import("./plugins/runtime/runtime-web-channel-plugin.js");
  return webChannelRuntimePromise;
}

// 导出 getReplyFromConfig 函数，延迟加载实现
export const getReplyFromConfig: GetReplyFromConfig = async (...args) =>
  (await loadReplyRuntime()).getReplyFromConfig(...args);
// 导出 promptYesNo 函数，延迟加载实现
export const promptYesNo: PromptYesNo = async (...args) =>
  (await loadPromptRuntime()).promptYesNo(...args);
// 导出 ensureBinary 函数，延迟加载实现
export const ensureBinary: EnsureBinary = async (...args) =>
  (await loadBinariesRuntime()).ensureBinary(...args);
// 导出 runExec 函数，延迟加载实现
export const runExec: RunExec = async (...args) => (await loadExecRuntime()).runExec(...args);
// 导出 runCommandWithTimeout 函数，延迟加载实现
export const runCommandWithTimeout: RunCommandWithTimeout = async (...args) =>
  (await loadExecRuntime()).runCommandWithTimeout(...args);
// 导出 monitorWebChannel 函数，延迟加载实现
export const monitorWebChannel: MonitorWebChannel = async (...args) =>
  (await loadWebChannelRuntime()).monitorWebChannel(...args);

// 重新导出以下函数/类/常量作为库导出

// 导出 applyTemplate 模板函数
export {
  applyTemplate,
  // 导出 createDefaultDeps 创建默认依赖函数
  createDefaultDeps,
  // 导出 deriveSessionKey 推导会话密钥函数
  deriveSessionKey,
  // 导出 describePortOwner 描述端口所有者函数
  describePortOwner,
  // 导出 ensurePortAvailable 确保端口可用函数
  ensurePortAvailable,
  // 导出 handlePortError 处理端口错误函数
  handlePortError,
  // 导出 loadConfig 加载配置函数
  loadConfig,
  // 导出 loadSessionStore 加载会话存储函数
  loadSessionStore,
  // 导出 normalizeE164 标准化 E164 函数
  normalizeE164,
  // 导出 PortInUseError 端口占用错误类
  PortInUseError,
  // 导出 resolveSessionKey 解析会话密钥函数
  resolveSessionKey,
  // 导出 resolveStorePath 解析存储路径函数
  resolveStorePath,
  // 导出 saveSessionStore 保存会话存储函数
  saveSessionStore,
  // 导出 waitForever 永久等待函数
  waitForever,
};
