// 字符串规范化工具
import { normalizeOptionalString } from "../shared/string-coerce.js";

// 会话记录更新类型
export type SessionTranscriptUpdate = {
  sessionFile: string;  // 会话文件路径
  sessionKey?: string;  // 会话键
  message?: unknown;  // 消息内容
  messageId?: string;  // 消息 ID
};

// 会话记录监听器类型
type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;

// 会话记录监听器集合
const SESSION_TRANSCRIPT_LISTENERS = new Set<SessionTranscriptListener>();

// 订阅会话记录更新
// listener: 要添加的监听器函数
// 返回取消订阅的函数
export function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void {
  SESSION_TRANSCRIPT_LISTENERS.add(listener);
  return () => {
    SESSION_TRANSCRIPT_LISTENERS.delete(listener);
  };
}

// 发送会话记录更新
export function emitSessionTranscriptUpdate(update: string | SessionTranscriptUpdate): void {
  // 标准化更新对象
  const normalized =
    typeof update === "string"
      ? { sessionFile: update }  // 如果是字符串，作为 sessionFile
      : {
          sessionFile: update.sessionFile,
          sessionKey: update.sessionKey,
          message: update.message,
          messageId: update.messageId,
        };
  // 规范化会话文件路径
  const trimmed = normalizeOptionalString(normalized.sessionFile);
  if (!trimmed) {
    return;
  }
  // 构建标准化的更新对象
  const nextUpdate: SessionTranscriptUpdate = {
    sessionFile: trimmed,
    // 可选：会话键
    ...(normalizeOptionalString(normalized.sessionKey)
      ? { sessionKey: normalizeOptionalString(normalized.sessionKey) }
      : {}),
    // 可选：消息
    ...(normalized.message !== undefined ? { message: normalized.message } : {}),
    // 可选：消息 ID
    ...(normalizeOptionalString(normalized.messageId)
      ? { messageId: normalizeOptionalString(normalized.messageId) }
      : {}),
  };
  // 通知所有监听器
  for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
    try {
      listener(nextUpdate);
    } catch {
      /* ignore */
    }
  }
}
