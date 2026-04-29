/**
 * Gateway 启动引导模块
 * 负责执行 BOOT.md 文件中定义的引导检查任务
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.types.js";
import { agentCommand } from "../commands/agent.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";

/**
 * 生成唯一的引导会话 ID
 * 格式: boot-{ISO时间戳}-{8位随机UUID}
 * @returns 引导会话 ID 字符串
 */
function generateBootSessionId(): string {
  const now = new Date();
  // 将 ISO 时间格式转换为更紧凑的格式：替换冒号和点，移除 T 和 Z
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  // 生成 8 位随机后缀以确保唯一性
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

/**
 * 会话映射快照类型
 * 用于保存和恢复主会话的映射关系
 */
type SessionMappingSnapshot = {
  storePath: string;      // 会话存储文件路径
  sessionKey: string;     // 会话密钥
  canRestore: boolean;    // 是否可以恢复
  hadEntry: boolean;      // 快照前是否存在条目
  entry?: SessionEntry;   // 会话条目内容（如果存在）
};

// 创建 gateway/boot 子系统日志记录器
const log = createSubsystemLogger("gateway/boot");
// BOOT.md 文件名常量
const BOOT_FILENAME = "BOOT.md";

/**
 * 引导运行结果类型
 * 表示引导检查的各种可能结果
 */
export type BootRunResult =
  | { status: "skipped"; reason: "missing" | "empty" }  // 跳过：文件缺失或为空
  | { status: "ran" }                                      // 已运行
  | { status: "failed"; reason: string };                 // 失败：包含失败原因

/**
 * 构建引导提示内容
 * 将 BOOT.md 文件内容包装成特定的提示格式
 * @param content - BOOT.md 文件内容
 * @returns 格式化后的提示字符串
 */
function buildBootPrompt(content: string) {
  return [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "",
    "BOOT.md:",
    content,
    "",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
    "Use the `target` field (not `to`) for message tool destinations.",
    // 发送消息后仅回复静默令牌
    `After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
    // 如果无需操作则仅回复静默令牌
    `If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

/**
 * 加载 BOOT.md 文件内容
 * 读取工作区目录下的 BOOT.md 文件并返回其状态和内容
 * @param workspaceDir - 工作区目录路径
 * @returns 返回文件内容或状态信息
 */
async function loadBootFile(
  workspaceDir: string,
): Promise<{ content?: string; status: "ok" | "missing" | "empty" }> {
  // 拼接 BOOT.md 文件完整路径
  const bootPath = path.join(workspaceDir, BOOT_FILENAME);
  try {
    // 尝试读取文件内容
    const content = await fs.readFile(bootPath, "utf-8");
    const trimmed = content.trim();
    // 如果内容为空，返回 empty 状态
    if (!trimmed) {
      return { status: "empty" };
    }
    // 返回正常状态和去空格后的内容
    return { status: "ok", content: trimmed };
  } catch (err) {
    const anyErr = err as { code?: string };
    // 如果是文件不存在错误，返回 missing 状态
    if (anyErr.code === "ENOENT") {
      return { status: "missing" };
    }
    // 其他错误向上抛出
    throw err;
  }
}

/**
 * 创建主会话映射的快照
 * 保存当前会话映射状态以便后续恢复
 * @param params - 包含配置和会话密钥的参数对象
 * @returns 会话映射快照
 */
function snapshotMainSessionMapping(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): SessionMappingSnapshot {
  // 从会话密钥解析出 agent ID
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  // 解析会话存储文件路径
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    // 加载会话存储（跳过缓存）
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    if (!entry) {
      // 如果条目不存在，返回可恢复但无条目的快照
      return {
        storePath,
        sessionKey: params.sessionKey,
        canRestore: true,
        hadEntry: false,
      };
    }
    // 返回包含条目的快照
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: true,
      hadEntry: true,
      entry: structuredClone(entry),
    };
  } catch (err) {
    // 加载失败时记录调试日志并返回不可恢复的快照
    log.debug("boot: could not snapshot main session mapping", {
      sessionKey: params.sessionKey,
      error: String(err),
    });
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: false,
      hadEntry: false,
    };
  }
}

/**
 * 恢复主会话映射
 * 根据快照恢复之前保存的会话映射状态
 * @param snapshot - 会话映射快照
 * @returns 如果失败返回错误消息，否则返回 undefined
 */
async function restoreMainSessionMapping(
  snapshot: SessionMappingSnapshot,
): Promise<string | undefined> {
  // 如果快照标记为不可恢复，直接返回
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    // 更新会话存储
    await updateSessionStore(
      snapshot.storePath,
      (store) => {
        if (snapshot.hadEntry && snapshot.entry) {
          // 如果快照前有条目，恢复该条目
          store[snapshot.sessionKey] = snapshot.entry;
          return;
        }
        // 否则删除该会话密钥
        delete store[snapshot.sessionKey];
      },
      { activeSessionKey: snapshot.sessionKey },
    );
    return undefined;
  } catch (err) {
    // 返回格式化后的错误消息
    return formatErrorMessage(err);
  }
}

/**
 * 执行一次引导检查
 * 读取并执行 BOOT.md 文件中定义的引导任务
 * @param params - 包含配置、依赖、工作区目录等参数
 * @returns 引导运行结果
 */
export async function runBootOnce(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  workspaceDir: string;
  agentId?: string;
}): Promise<BootRunResult> {
  // 创建引导运行时环境：空日志、错误记录使用 subsystem logger、退出函数使用默认
  const bootRuntime: RuntimeEnv = {
    log: () => {},
    error: (message) => log.error(String(message)),
    exit: defaultRuntime.exit,
  };
  let result: Awaited<ReturnType<typeof loadBootFile>>;
  try {
    // 加载 BOOT.md 文件
    result = await loadBootFile(params.workspaceDir);
  } catch (err) {
    // 加载失败时格式化错误并返回失败状态
    const message = formatErrorMessage(err);
    log.error(`boot: failed to read ${BOOT_FILENAME}: ${message}`);
    return { status: "failed", reason: message };
  }

  // 如果文件缺失或为空，跳过执行
  if (result.status === "missing" || result.status === "empty") {
    return { status: "skipped", reason: result.status };
  }

  // 解析主会话密钥
  const sessionKey = params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
  // 构建引导提示内容
  const message = buildBootPrompt(result.content ?? "");
  // 生成唯一会话 ID
  const sessionId = generateBootSessionId();
  // 创建会话映射快照
  const mappingSnapshot = snapshotMainSessionMapping({
    cfg: params.cfg,
    sessionKey,
  });

  let agentFailure: string | undefined;
  try {
    // 执行 agent 命令运行引导任务
    await agentCommand(
      {
        message,
        sessionKey,
        sessionId,
        deliver: false,        // 不投递消息
        senderIsOwner: true,   // 发送者为所有者
      },
      bootRuntime,
      params.deps,
    );
  } catch (err) {
    // 捕获 agent 运行失败
    agentFailure = formatErrorMessage(err);
    log.error(`boot: agent run failed: ${agentFailure}`);
  }

  // 尝试恢复会话映射
  const mappingRestoreFailure = await restoreMainSessionMapping(mappingSnapshot);
  if (mappingRestoreFailure) {
    log.error(`boot: failed to restore main session mapping: ${mappingRestoreFailure}`);
  }

  // 如果 agent 和映射恢复都成功，返回 ran 状态
  if (!agentFailure && !mappingRestoreFailure) {
    return { status: "ran" };
  }
  // 构建失败原因字符串
  const reasonParts = [
    agentFailure ? `agent run failed: ${agentFailure}` : undefined,
    mappingRestoreFailure ? `mapping restore failed: ${mappingRestoreFailure}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return { status: "failed", reason: reasonParts.join("; ") };
}
