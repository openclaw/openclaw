// 字符串规范化工具
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

// 解析后的 Agent 会话键类型
export type ParsedAgentSessionKey = {
  agentId: string;  // Agent ID
  rest: string;  // 剩余部分
};

// 解析后的线程会话后缀类型
export type ParsedThreadSessionSuffix = {
  baseSessionKey: string | undefined;  // 基础会话键
  threadId: string | undefined;  // 线程 ID
};

// 原始会话对话引用类型
export type RawSessionConversationRef = {
  channel: string;  // 渠道
  kind: "group" | "channel";  // 类型（群组或频道）
  rawId: string;  // 原始 ID
  prefix: string;  // 前缀
};

/**
 * 以规范的小写不敏感方式解析 Agent 作用域会话键。
 * 返回值规范化为小写以进行稳定的比较/路由。
 * sessionKey: 要解析的会话键
 */
export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  const raw = normalizeOptionalLowercaseString(sessionKey);
  if (!raw) {
    return null;
  }
  // 按冒号分割并过滤空字符串
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3) {
    return null;
  }
  // 必须以 "agent" 开头
  if (parts[0] !== "agent") {
    return null;
  }
  const agentId = normalizeOptionalString(parts[1]);
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
}

// 检查是否是 Cron 运行会话键
export function isCronRunSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return /^cron:[^:]+:run:[^:]+$/.test(parsed.rest);
}

// 检查是否是 Cron 会话键
export function isCronSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return normalizeOptionalLowercaseString(parsed.rest)?.startsWith("cron:") === true;
}

// 检查是否是子代理会话键
export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  // 直接以 "subagent:" 开头
  if (normalizeOptionalLowercaseString(raw)?.startsWith("subagent:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeOptionalLowercaseString(parsed?.rest)?.startsWith("subagent:") === true;
}

// 获取子代理深度
export function getSubagentDepth(sessionKey: string | undefined | null): number {
  const raw = normalizeOptionalLowercaseString(sessionKey);
  if (!raw) {
    return 0;
  }
  // 计算 ":subagent:" 出现的次数
  return raw.split(":subagent:").length - 1;
}

// 检查是否是 ACP 会话键
export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  // 直接以 "acp:" 开头
  if (normalized.startsWith("acp:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeOptionalLowercaseString(parsed?.rest)?.startsWith("acp:") === true;
}

// 解析线程会话后缀
export function parseThreadSessionSuffix(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return { baseSessionKey: undefined, threadId: undefined };
  }

  const lowerRaw = normalizeLowercaseStringOrEmpty(raw);
  const threadMarker = ":thread:";
  const threadIndex = lowerRaw.lastIndexOf(threadMarker);
  const markerIndex = threadIndex;
  const marker = threadMarker;

  // 基础会话键是线程标记之前的部分
  const baseSessionKey = markerIndex === -1 ? raw : raw.slice(0, markerIndex);
  // 线程 ID 是标记之后的值
  const threadIdRaw = markerIndex === -1 ? undefined : raw.slice(markerIndex + marker.length);
  const threadId = normalizeOptionalString(threadIdRaw);

  return { baseSessionKey, threadId };
}

// 解析原始会话对话引用
export function parseRawSessionConversationRef(
  sessionKey: string | undefined | null,
): RawSessionConversationRef | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return null;
  }

  const rawParts = raw.split(":").filter(Boolean);
  // 计算身体开始索引（对于 agent 作用域的键跳过前缀）
  const bodyStartIndex =
    rawParts.length >= 3 && normalizeOptionalLowercaseString(rawParts[0]) === "agent" ? 2 : 0;
  const parts = rawParts.slice(bodyStartIndex);
  if (parts.length < 3) {
    return null;
  }

  const channel = normalizeOptionalLowercaseString(parts[0]);
  const kind = normalizeOptionalLowercaseString(parts[1]);
  // 必须是 group 或 channel
  if (!channel || (kind !== "group" && kind !== "channel")) {
    return null;
  }

  const rawId = normalizeOptionalString(parts.slice(2).join(":"));
  const prefix = normalizeOptionalString(rawParts.slice(0, bodyStartIndex + 2).join(":"));
  if (!rawId || !prefix) {
    return null;
  }

  return { channel, kind, rawId, prefix };
}

// 解析线程父会话键
export function resolveThreadParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(sessionKey);
  if (!threadId) {
    return null;
  }
  const parent = normalizeOptionalString(baseSessionKey);
  if (!parent) {
    return null;
  }
  return parent;
}
