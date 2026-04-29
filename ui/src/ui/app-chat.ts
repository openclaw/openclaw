/**
 * 聊天功能模块
 * 
 * 本模块处理聊天界面的核心逻辑，包括消息发送、接收、队列管理、
 * 斜杠命令处理、聊天历史记录等功能。
 */

// 导入设置最后活跃会话键的函数
import { setLastActiveSessionKey } from "./app-last-active-session.ts";
// 导入聊天滚动相关函数
import { scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";
// 导入工具流重置函数
import { resetToolStream } from "./app-tool-stream.ts";
// 导入聊天附件相关函数
import {
  cloneChatAttachmentsMetadata,
  discardChatAttachmentDataUrls,
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./chat/attachment-payload-store.ts";
// 导入聊天输入历史相关函数和类型
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
  type ChatInputHistoryState,
} from "./chat/input-history.ts";
// 导入聊天侧边结果类型
import type { ChatSideResult } from "./chat/side-result.ts";
// 导入斜杠命令执行函数
import { executeSlashCommand } from "./chat/slash-command-executor.ts";
// 导入斜杠命令解析和刷新函数
import { parseSlashCommand, refreshSlashCommands } from "./chat/slash-commands.ts";
// 导入控制面板认证头解析函数
import { resolveControlUiAuthHeader } from "./control-ui-auth.ts";
// 导入聊天相关函数
import {
  abortChatRun,
  loadChatHistory,
  sendChatMessage,
  sendDetachedChatMessage,
  sendSteerChatMessage,
  type ChatState,
} from "./controllers/chat.ts";
// 导入加载模型函数
import { loadModels } from "./controllers/models.ts";
// 导入加载会话函数
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";
// 导入 Gateway 类型
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
// 导入基础路径规范化函数
import { normalizeBasePath } from "./navigation.ts";
// 导入解析代理会话键函数
import { parseAgentSessionKey } from "./session-key.ts";
// 导入字符串规范化函数
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";
// 导入聊天模型覆盖和目录类型
import type { ChatModelOverride, ModelCatalogEntry } from "./types.ts";
// 导入会话列表结果类型
import type { SessionsListResult } from "./types.ts";
// 导入聊天附件和队列项类型
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
// 导入 UUID 生成函数
import { generateUUID } from "./uuid.ts";
// 导入渲染控制面板头像 URL 判断函数
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";

// ============ 类型定义 ============

/**
 * 聊天宿主类型
 * 组合了聊天输入历史状态和聊天所需的各种状态
 */
export type ChatHost = ChatInputHistoryState & {
  // Gateway 客户端实例
  client: GatewayBrowserClient | null;
  // 当前聊天流内容
  chatStream: string | null;
  // 是否已连接
  connected: boolean;
  // 聊天附件列表
  chatAttachments: ChatAttachment[];
  // 聊天消息队列
  chatQueue: ChatQueueItem[];
  // 当前聊天运行 ID
  chatRunId: string | null;
  // 是否正在发送聊天
  chatSending: boolean;
  // 最近错误（可选）
  lastError?: string | null;
  // 基础路径
  basePath: string;
  // 设置（可选）
  settings?: { token?: string | null };
  // 密码（可选）
  password?: string | null;
  // Hello 响应（可选）
  hello: GatewayHelloOk | null;
  // 聊天头像 URL
  chatAvatarUrl: string | null;
  // 聊天头像来源（可选）
  chatAvatarSource?: string | null;
  // 聊天头像状态（可选）
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  // 聊天头像原因（可选）
  chatAvatarReason?: string | null;
  // 聊天侧边结果（可选）
  chatSideResult?: ChatSideResult | null;
  // 聊天侧边结果终端运行集合（可选）
  chatSideResultTerminalRuns?: Set<string>;
  // 聊天模型覆盖映射
  chatModelOverrides: Record<string, ChatModelOverride | null>;
  // 是否正在加载聊天模型
  chatModelsLoading: boolean;
  // 聊天模型目录
  chatModelCatalog: ModelCatalogEntry[];
  // 会话结果（可选）
  sessionsResult?: SessionsListResult | null;
  // 更新完成 Promise（可选）
  updateComplete?: Promise<unknown>;
  // 聊天后需要刷新的会话集合
  refreshSessionsAfterChat: Set<string>;
  // 待处理的中止请求（可选）
  pendingAbort?: { runId: string; sessionKey: string } | null;
  // 聊天提交守卫映射（可选）
  chatSubmitGuards?: Map<string, Promise<void>>;
  /** 斜杠命令副作用回调，需要应用级访问 */
  onSlashAction?: (action: string) => void;
};

/**
 * 聊天发送选项
 */
export type ChatSendOptions = {
  // 是否确认重置
  confirmReset?: boolean;
  // 是否恢复草稿
  restoreDraft?: boolean;
};

// 导出的常量：活跃聊天会话的分钟数
export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;

// 重新导出输入历史相关函数
export {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  navigateChatInputHistory,
  resetChatInputHistoryNavigation,
};
// 重新导出类型
export type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult };

// ============ 辅助函数 ============

/**
 * 判断聊天是否忙碌
 * 当正在发送消息或存在运行中的聊天时为真
 * @param host - 聊天宿主
 * @returns 是否忙碌
 */
export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

/**
 * 判断是否为停止命令
 * @param text - 输入文本
 * @returns 是否为停止命令
 */
export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  // 检查是否为 /stop
  if (normalized === "/stop") {
    return true;
  }
  // 检查是否为其他停止关键词
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

/**
 * 判断是否为重置命令
 * @param text - 输入文本
 * @returns 是否为重置命令
 */
function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  // 检查是否为 /new 或 /reset
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  // 检查是否以 /new 或 /reset 开头
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

/**
 * 确认聊天重置命令
 * @param text - 输入文本
 * @returns 是否确认重置
 */
function confirmChatResetCommand(text: string) {
  // 如果不是重置命令，默认确认
  if (!isChatResetCommand(text)) {
    return true;
  }
  // 如果没有 confirm 函数，返回 false
  if (typeof globalThis.confirm !== "function") {
    return false;
  }
  return globalThis.confirm("Start a new session? This will reset the current chat.");
}

/**
 * 判断是否为 btw 命令（侧边消息）
 * @param text - 输入文本
 * @returns 是否为 btw 命令
 */
function isBtwCommand(text: string) {
  return /^\/btw(?::|\s|$)/i.test(text.trim());
}

// ============ 聊天处理函数 ============

/**
 * 处理中止聊天
 * 如果断开连接但有运行中的 runId，将中止排队等待重连
 * @param host - 聊天宿主
 */
export async function handleAbortChat(host: ChatHost) {
  // 如果断开连接但有运行中的 runId，排队中止
  if (!host.connected && host.chatRunId) {
    host.chatMessage = "";
    resetChatInputHistoryNavigation(host);
    host.pendingAbort = { runId: host.chatRunId, sessionKey: host.sessionKey };
    return;
  }
  // 如果断开连接，直接返回
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  resetChatInputHistoryNavigation(host);
  await abortChatRun(host as unknown as ChatState);
}

/**
 * 将聊天消息加入队列
 * @param host - 聊天宿主
 * @param text - 消息文本
 * @param attachments - 附件（可选）
 * @param refreshSessions - 是否刷新会话（可选）
 * @param localCommand - 本地命令（可选）
 */
function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
  localCommand?: { args: string; name: string },
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  // 如果没有文本和附件，直接返回
  if (!trimmed && !hasAttachments) {
    return;
  }
  // 添加到队列
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      refreshSessions,
      localCommandArgs: localCommand?.args,
      localCommandName: localCommand?.name,
    },
  ];
}

/**
 * 将待处理运行消息加入队列
 * @param host - 聊天宿主
 * @param text - 消息文本
 * @param pendingRunId - 待处理的运行 ID
 * @param attachments - 附件（可选）
 */
function enqueuePendingRunMessage(
  host: ChatHost,
  text: string,
  pendingRunId: string,
  attachments?: ChatAttachment[],
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  // 如果没有文本和附件，直接返回
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      kind: "steered",
      attachments: hasAttachments ? cloneChatAttachmentsMetadata(attachments ?? []) : undefined,
      pendingRunId,
    },
  ];
}

/**
 * 立即发送聊天消息
 * @param host - 聊天宿主
 * @param message - 消息文本
 * @param opts - 选项（可选）
 * @returns 是否发送成功
 */
async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  // 重置工具流
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  // 重置滚动状态
  resetChatScroll(host as unknown as Parameters<typeof resetChatScroll>[0]);
  // 发送聊天消息
  const runId = await sendChatMessage(host as unknown as ChatState, message, opts?.attachments);
  const ok = Boolean(runId);
  // 如果失败且有之前的草稿，恢复它
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  // 如果失败且有之前的附件，恢复它们
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  // 如果成功
  if (ok) {
    // 设置最后活跃会话
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
    // 重置输入历史导航
    resetChatInputHistoryNavigation(host);
  }
  // 如果成功且需要恢复草稿
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  // 如果成功且需要恢复附件
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  // 强制滚动到底部
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0], true);
  // 如果成功且没有运行中的聊天，继续处理队列
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  // 如果成功且需要刷新会话
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  // 如果成功，释放附件数据 URL
  if (ok) {
    discardChatAttachmentDataUrls(opts?.attachments);
  }
  return ok;
}

/**
 * 获取附件提交签名
 * 用于标识附件的唯一性
 * @param attachment - 聊天附件
 * @returns 签名字符串
 */
function attachmentSubmitSignature(attachment: ChatAttachment): string {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return JSON.stringify([
    attachment.id,
    attachment.mimeType,
    attachment.fileName ?? "",
    attachment.sizeBytes ?? 0,
    dataUrl?.length ?? 0,
    dataUrl?.slice(0, 64) ?? "",
  ]);
}

/**
 * 生成聊天提交键
 * 用于去重和防重复提交
 * @param host - 聊天宿主
 * @param kind - 提交类型
 * @param message - 消息文本
 * @param attachments - 附件列表
 * @returns 提交键
 */
function chatSubmitKey(
  host: ChatHost,
  kind: "btw" | "message",
  message: string,
  attachments: ChatAttachment[],
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    message.trim(),
    attachments.map(attachmentSubmitSignature),
  ]);
}

/**
 * 使用聊天提交守卫执行操作
 * 防止重复提交
 * @param host - 聊天宿主
 * @param key - 守卫键
 * @param run - 要执行的异步函数
 * @returns 执行结果或 undefined
 */
async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const guards = (host.chatSubmitGuards ??= new Map<string, Promise<void>>());
  // 如果已有相同守卫正在执行，返回 undefined
  if (guards.has(key)) {
    return undefined;
  }
  let releaseGuard!: () => void;
  // 创建守卫 Promise
  const guard = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  guards.set(key, guard);
  try {
    return await run();
  } finally {
    // 释放守卫
    releaseGuard();
    // 清理守卫映射
    if (guards.get(key) === guard) {
      guards.delete(key);
    }
  }
}

/**
 * 发送独立的 btw 消息
 * @param host - 聊天宿主
 * @param message - 消息文本
 * @param opts - 选项（可选）
 * @returns 是否发送成功
 */
async function sendDetachedBtwMessage(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
  },
) {
  const runId = await sendDetachedChatMessage(
    host as unknown as ChatState,
    message,
    opts?.attachments,
  );
  const ok = Boolean(runId);
  // 如果失败，恢复草稿
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  // 如果失败，恢复附件
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  // 如果成功
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
    // 释放附件载荷
    releaseChatAttachmentPayloads(opts?.attachments);
  }
  return ok;
}

/**
 * 处理转向排队的聊天消息
 * @param host - 聊天宿主
 * @param id - 消息 ID
 */
export async function steerQueuedChatMessage(host: ChatHost, id: string) {
  // 如果未连接或没有运行中的聊天，不处理
  if (!host.connected || !host.chatRunId) {
    return;
  }
  const activeRunId = host.chatRunId;
  // 找到要转向的消息
  const item = host.chatQueue.find(
    (entry) => entry.id === id && !entry.pendingRunId && !entry.localCommandName,
  );
  if (!item) {
    return;
  }
  const message = item.text.trim();
  const attachments = item.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  if (!message && !hasAttachments) {
    return;
  }

  // 更新队列项为转向状态
  host.chatQueue = host.chatQueue.map((entry) =>
    entry.id === id ? { ...entry, kind: "steered", pendingRunId: activeRunId } : entry,
  );
  // 发送转向消息
  const runId = await sendSteerChatMessage(
    host as unknown as ChatState,
    message,
    hasAttachments ? attachments : undefined,
  );
  // 如果失败，恢复队列项
  if (!runId) {
    host.chatQueue = host.chatQueue.map((entry) => (entry.id === id ? item : entry));
    return;
  }
  // 释放附件载荷
  releaseChatAttachmentPayloads(attachments);
  setLastActiveSessionKey(
    host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
    host.sessionKey,
  );
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

/**
 * 清空聊天队列
 * @param host - 聊天宿主
 */
async function flushChatQueue(host: ChatHost) {
  // 如果未连接或聊天忙碌，不处理
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  // 找到下一个未处理的队列项
  const nextIndex = host.chatQueue.findIndex((item) => !item.pendingRunId);
  if (nextIndex < 0) {
    return;
  }
  const next = host.chatQueue[nextIndex];
  // 从队列中移除
  host.chatQueue = host.chatQueue.filter((_, index) => index !== nextIndex);
  let ok = false;
  try {
    // 如果是本地命令，分发执行
    if (next.localCommandName) {
      await dispatchSlashCommand(host, next.localCommandName, next.localCommandArgs ?? "");
      ok = true;
    } else {
      // 否则发送消息
      ok = await sendChatMessageNow(host, next.text, {
        attachments: next.attachments,
        refreshSessions: next.refreshSessions,
      });
    }
  } catch (err) {
    host.lastError = String(err);
  }
  // 如果失败，将消息放回队列前端
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  } else if (host.chatQueue.length > 0) {
    // 继续清空队列——本地命令不阻塞服务器响应
    void flushChatQueue(host);
  }
}

/**
 * 从队列中移除消息
 * @param host - 聊天宿主
 * @param id - 消息 ID
 */
export function removeQueuedMessage(host: ChatHost, id: string) {
  const removed = host.chatQueue.filter((item) => item.id === id);
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
  // 释放被移除消息的附件载荷
  for (const item of removed) {
    releaseChatAttachmentPayloads(item.attachments);
  }
}

/**
 * 清除与运行关联的待处理队列项
 * @param host - 聊天宿主
 * @param runId - 运行 ID
 */
export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
  // 释放被移除消息的附件载荷
  for (const item of removed) {
    releaseChatAttachmentPayloads(item.attachments);
  }
}

/**
 * 处理发送聊天
 * @param host - 聊天宿主
 * @param messageOverride - 消息覆盖（可选）
 * @param opts - 选项（可选）
 */
export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendOptions,
) {
  // 如果未连接，不处理
  if (!host.connected) {
    return;
  }
  // 保存之前的草稿
  const previousDraft = host.chatMessage;
  // 获取消息文本
  const message = (messageOverride ?? host.chatMessage).trim();
  // 获取附件
  const attachments = host.chatAttachments ?? [];
  // 如果有消息覆盖，附件不发送
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // 如果没有消息和附件，直接返回
  if (!message && !hasAttachments) {
    return;
  }

  // 如果需要确认重置但不确认，不处理
  if (messageOverride != null && opts?.confirmReset && !confirmChatResetCommand(message)) {
    return;
  }

  // 处理停止命令
  if (isChatStopCommand(message)) {
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
    }
    await handleAbortChat(host);
    return;
  }

  // 处理 btw 命令
  if (isBtwCommand(message)) {
    const submitKey = chatSubmitKey(host, "btw", message, attachmentsToSend);
    await withChatSubmitGuard(host, submitKey, async () => {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
        host.chatMessage = "";
        host.chatAttachments = [];
        resetChatInputHistoryNavigation(host);
      }
      await sendDetachedBtwMessage(host, message, {
        previousDraft: messageOverride == null ? previousDraft : undefined,
        attachments: hasAttachments ? attachmentsToSend : undefined,
        previousAttachments: messageOverride == null ? attachments : undefined,
      });
    });
    return;
  }

  // 拦截本地斜杠命令（/status, /model, /compact 等）
  const parsed = parseSlashCommand(message);
  if (parsed?.command.executeLocal) {
    // 如果聊天忙碌且命令需要排队
    if (isChatBusy(host) && shouldQueueLocalSlashCommand(parsed.command.key)) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
        host.chatMessage = "";
        host.chatAttachments = [];
        resetChatInputHistoryNavigation(host);
      }
      enqueueChatMessage(host, message, undefined, isChatResetCommand(message), {
        args: parsed.args,
        name: parsed.command.key,
      });
      return;
    }
    // 保存草稿引用
    const prevDraft = messageOverride == null ? previousDraft : undefined;
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, message);
      host.chatMessage = "";
      host.chatAttachments = [];
      resetChatInputHistoryNavigation(host);
    }
    await dispatchSlashCommand(host, parsed.command.key, parsed.args, {
      previousDraft: prevDraft,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    });
    return;
  }

  // 确定是否需要刷新会话
  const refreshSessions = isChatResetCommand(message);
  const submitKey = chatSubmitKey(host, "message", message, attachmentsToSend);
  await withChatSubmitGuard(host, submitKey, async () => {
    if (messageOverride == null) {
      host.chatMessage = "";
      host.chatAttachments = [];
      resetChatInputHistoryNavigation(host);
    }

    // 如果聊天忙碌，加入队列
    if (isChatBusy(host)) {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, message);
      }
      enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
      return;
    }

    // 立即发送消息
    await sendChatMessageNow(host, message, {
      previousDraft: messageOverride == null ? previousDraft : undefined,
      restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
      attachments: hasAttachments ? attachmentsToSend : undefined,
      previousAttachments: messageOverride == null ? attachments : undefined,
      restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
      refreshSessions,
    });
  });
}

/**
 * 判断本地斜杠命令是否应该排队
 * @param name - 命令名称
 * @returns 是否应该排队
 */
function shouldQueueLocalSlashCommand(name: string): boolean {
  return !["stop", "focus", "export-session", "steer", "redirect"].includes(name);
}

// ============ 斜杠命令分发 ============

/**
 * 分发斜杠命令
 * @param host - 聊天宿主
 * @param name - 命令名称
 * @param args - 命令参数
 * @param sendOpts - 发送选项（可选）
 */
async function dispatchSlashCommand(
  host: ChatHost,
  name: string,
  args: string,
  sendOpts?: { previousDraft?: string; restoreDraft?: boolean },
) {
  switch (name) {
    case "stop":
      await handleAbortChat(host);
      return;
    case "new":
      await sendChatMessageNow(host, "/new", {
        refreshSessions: true,
        previousDraft: sendOpts?.previousDraft,
        restoreDraft: sendOpts?.restoreDraft,
      });
      return;
    case "reset":
      await sendChatMessageNow(host, "/reset", {
        refreshSessions: true,
        previousDraft: sendOpts?.previousDraft,
        restoreDraft: sendOpts?.restoreDraft,
      });
      return;
    case "clear":
      await clearChatHistory(host);
      return;
    case "focus":
      host.onSlashAction?.("toggle-focus");
      return;
    case "export-session":
      host.onSlashAction?.("export");
      return;
  }

  // 如果没有客户端，不处理
  if (!host.client) {
    return;
  }

  const targetSessionKey = host.sessionKey;
  // 执行命令
  const result = await executeSlashCommand(host.client, targetSessionKey, name, args, {
    chatModelCatalog: host.chatModelCatalog,
    sessionsResult: host.sessionsResult,
  });

  // 如果有命令结果内容，注入到聊天
  if (result.content) {
    injectCommandResult(host, result.content);
  }

  // 如果需要跟踪运行 ID
  if (result.trackRunId) {
    host.chatRunId = result.trackRunId;
    host.chatStream = "";
    host.chatSending = false;
  }

  // 如果有待处理的当前运行，加入队列
  if (result.pendingCurrentRun && host.chatRunId) {
    enqueuePendingRunMessage(host, `/${name} ${args}`.trim(), host.chatRunId);
  }

  // 如果有会话补丁
  if (result.sessionPatch && "modelOverride" in result.sessionPatch) {
    host.chatModelOverrides = {
      ...host.chatModelOverrides,
      [targetSessionKey]: result.sessionPatch.modelOverride ?? null,
    };
    host.onSlashAction?.("refresh-tools-effective");
  }

  // 如果需要刷新，执行刷新
  if (result.action === "refresh") {
    await refreshChat(host);
  }

  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

/**
 * 清空聊天历史
 * @param host - 聊天宿主
 */
async function clearChatHistory(host: ChatHost) {
  // 如果没有客户端或未连接，不处理
  if (!host.client || !host.connected) {
    return;
  }
  try {
    // 请求重置会话
    await host.client.request("sessions.reset", { key: host.sessionKey });
    host.chatMessages = [];
    host.chatSideResult = null;
    host.chatSideResultTerminalRuns?.clear();
    host.chatStream = null;
    host.chatRunId = null;
    // 重新加载聊天历史
    await loadChatHistory(host as unknown as ChatState);
  } catch (err) {
    host.lastError = String(err);
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
}

/**
 * 注入命令结果到聊天消息
 * @param host - 聊天宿主
 * @param content - 结果内容
 */
function injectCommandResult(host: ChatHost, content: string) {
  host.chatMessages = [
    ...host.chatMessages,
    {
      role: "system",
      content,
      timestamp: Date.now(),
    },
  ];
}

/**
 * 刷新聊天
 * @param host - 聊天宿主
 * @param opts - 选项（可选）
 */
export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as ChatState),
    loadSessions(host as unknown as SessionsState, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    }),
    refreshChatAvatar(host),
    refreshChatModels(host),
    refreshChatCommands(host),
  ]);
  // 如果需要，安排滚动
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

/**
 * 刷新聊天模型
 * @param host - 聊天宿主
 */
async function refreshChatModels(host: ChatHost) {
  // 如果没有客户端或未连接
  if (!host.client || !host.connected) {
    host.chatModelsLoading = false;
    host.chatModelCatalog = [];
    return;
  }
  host.chatModelsLoading = true;
  try {
    host.chatModelCatalog = await loadModels(host.client);
  } finally {
    host.chatModelsLoading = false;
  }
}

/**
 * 刷新聊天命令
 * @param host - 聊天宿主
 */
async function refreshChatCommands(host: ChatHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveAgentIdForSession(host),
  });
}

// 导出队列刷新函数
export const flushChatQueueForEvent = flushChatQueue;

// ============ 聊天头像处理 ============

// 聊天头像请求版本映射（用于处理竞态条件）
const chatAvatarRequestVersions = new WeakMap<object, number>();

/**
 * 会话默认值快照类型
 */
type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

// 聊天头像对象 URL 映射
const chatAvatarObjectUrls = new WeakMap<object, string>();

/**
 * 开始聊天头像请求
 * @param host - 聊天宿主
 * @returns 请求版本号
 */
function beginChatAvatarRequest(host: ChatHost): number {
  const key = host as object;
  const nextVersion = (chatAvatarRequestVersions.get(key) ?? 0) + 1;
  chatAvatarRequestVersions.set(key, nextVersion);
  return nextVersion;
}

/**
 * 判断是否应该应用聊天头像结果
 * @param host - 聊天宿主
 * @param version - 请求版本
 * @param sessionKey - 会话键
 * @returns 是否应该应用
 */
function shouldApplyChatAvatarResult(host: ChatHost, version: number, sessionKey: string): boolean {
  return (
    chatAvatarRequestVersions.get(host as object) === version && host.sessionKey === sessionKey
  );
}

/**
 * 解析会话的代理 ID
 * @param host - 聊天宿主
 * @returns 代理 ID 或 null
 */
function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  // 从 hello 快照中获取默认代理 ID
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

/**
 * 构建头像元数据 URL
 * @param basePath - 基础路径
 * @param agentId - 代理 ID
 * @returns 元数据 URL
 */
function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

/**
 * 清除聊天头像 URL
 * @param host - 聊天宿主
 */
function clearChatAvatarUrl(host: ChatHost) {
  const key = host as object;
  const previousBlobUrl = chatAvatarObjectUrls.get(key);
  // 如果有之前的 blob URL，撤销它
  if (previousBlobUrl) {
    URL.revokeObjectURL(previousBlobUrl);
    chatAvatarObjectUrls.delete(key);
  }
  host.chatAvatarUrl = null;
}

/**
 * 清除聊天头像状态
 * @param host - 聊天宿主
 */
function clearChatAvatarState(host: ChatHost) {
  clearChatAvatarUrl(host);
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
}

/**
 * 设置聊天头像 URL
 * @param host - 聊天宿主
 * @param nextUrl - 下一个 URL
 */
function setChatAvatarUrl(host: ChatHost, nextUrl: string | null) {
  const key = host as object;
  const previousBlobUrl = chatAvatarObjectUrls.get(key);
  // 如果之前的 URL 不同，撤销它
  if (previousBlobUrl && previousBlobUrl !== nextUrl) {
    URL.revokeObjectURL(previousBlobUrl);
    chatAvatarObjectUrls.delete(key);
  }
  // 如果是 blob URL，缓存它
  if (nextUrl?.startsWith("blob:")) {
    chatAvatarObjectUrls.set(key, nextUrl);
  }
  host.chatAvatarUrl = nextUrl;
}

/**
 * 设置聊天头像元数据
 * @param host - 聊天宿主
 * @param data - 元数据
 */
function setChatAvatarMeta(
  host: ChatHost,
  data: {
    avatarSource?: unknown;
    avatarStatus?: unknown;
    avatarReason?: unknown;
  },
) {
  // 验证并规范化状态
  const status =
    data.avatarStatus === "none" ||
    data.avatarStatus === "local" ||
    data.avatarStatus === "remote" ||
    data.avatarStatus === "data"
      ? data.avatarStatus
      : null;
  // 设置头像来源
  host.chatAvatarSource =
    typeof data.avatarSource === "string" && data.avatarSource.trim()
      ? data.avatarSource.trim()
      : null;
  host.chatAvatarStatus = status;
  // 设置头像原因
  host.chatAvatarReason =
    typeof data.avatarReason === "string" && data.avatarReason.trim()
      ? data.avatarReason.trim()
      : null;
}

/**
 * 构建控制面板认证头
 * @param authHeader - 认证头
 * @returns 包含认证头的对象或 undefined
 */
function buildControlUiAuthHeaders(authHeader: string | null): Record<string, string> | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

/**
 * 判断是否为本地控制面板头像 URL
 * @param avatarUrl - 头像 URL
 * @returns 是否为本地 URL
 */
function isLocalControlUiAvatarUrl(avatarUrl: string): boolean {
  return avatarUrl.startsWith("/");
}

/**
 * 刷新聊天头像
 * @param host - 聊天宿主
 */
export async function refreshChatAvatar(host: ChatHost) {
  // 如果未连接，清除状态
  if (!host.connected) {
    clearChatAvatarState(host);
    return;
  }
  const sessionKey = host.sessionKey;
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  // 如果没有代理 ID，清除状态
  if (!agentId) {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      clearChatAvatarState(host);
    }
    return;
  }
  clearChatAvatarState(host);
  // 解析认证头
  const authHeader = resolveControlUiAuthHeader(host);
  const headers = buildControlUiAuthHeaders(authHeader);
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    // 获取头像元数据
    const res = await fetch(url, { method: "GET", ...(headers ? { headers } : {}) });
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    if (!res.ok) {
      clearChatAvatarState(host);
      return;
    }
    const data = (await res.json()) as {
      avatarUrl?: unknown;
      avatarSource?: unknown;
      avatarStatus?: unknown;
      avatarReason?: unknown;
    };
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    // 设置头像元数据
    setChatAvatarMeta(host, data);
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    // 如果没有有效 URL 或不可渲染，清除
    if (!avatarUrl || !isRenderableControlUiAvatarUrl(avatarUrl)) {
      clearChatAvatarUrl(host);
      return;
    }
    // 如果是本地 URL
    if (!isLocalControlUiAvatarUrl(avatarUrl)) {
      setChatAvatarUrl(host, avatarUrl);
      return;
    }
    // 获取远程头像
    const avatarRes = await fetch(avatarUrl, {
      method: "GET",
      ...(headers ? { headers } : {}),
    });
    if (!avatarRes.ok) {
      if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
        clearChatAvatarUrl(host);
      }
      return;
    }
    // 创建 blob URL
    const blobUrl = URL.createObjectURL(await avatarRes.blob());
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    setChatAvatarUrl(host, blobUrl);
  } catch {
    // 如果出错且版本匹配，清除状态
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      clearChatAvatarState(host);
    }
  }
}
