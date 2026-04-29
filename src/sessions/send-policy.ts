// 聊天类型规范化工具
import { normalizeChatType } from "../channels/chat-type.js";
// 会话聊天类型和会话条目类型
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
// OpenClaw 配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 字符串规范化工具
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
// 会话聊天类型派生工具
import { deriveSessionChatType } from "./session-chat-type.js";

// 会话发送策略决策类型：允许或拒绝
export type SessionSendPolicyDecision = "allow" | "deny";

// 规范化发送策略值
export function normalizeSendPolicy(raw?: string | null): SessionSendPolicyDecision | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (value === "allow") {
    return "allow";
  }
  if (value === "deny") {
    return "deny";
  }
  return undefined;
}

// 规范化匹配值
function normalizeMatchValue(raw?: string | null) {
  const value = normalizeOptionalLowercaseString(raw);
  return value ? value : undefined;
}

// 剥离 Agent 会话键前缀
// 规范格式：agent:<agentId>:<sessionKey...>
function stripAgentSessionKeyPrefix(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const parts = key.split(":").filter(Boolean);
  // 规范 Agent 会话键：agent:<agentId>:<sessionKey...>
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return key;
}

// 从键派生渠道
function deriveChannelFromKey(key?: string) {
  const normalizedKey = stripAgentSessionKeyPrefix(key);
  if (!normalizedKey) {
    return undefined;
  }
  const parts = normalizedKey.split(":").filter(Boolean);
  // 格式：channel:group|channel:<id>
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return normalizeMatchValue(parts[0]);
  }
  return undefined;
}

// 从键派生聊天类型
function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  const normalizedKey = normalizeOptionalLowercaseString(stripAgentSessionKeyPrefix(key));
  if (!normalizedKey) {
    return undefined;
  }
  const tokens = new Set(normalizedKey.split(":").filter(Boolean));
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  // 尝试派生聊天类型
  const derived = deriveSessionChatType(normalizedKey);
  if (derived !== "unknown") {
    return derived;
  }
  return undefined;
}

// 解析发送策略
export function resolveSendPolicy(params: {
  cfg: OpenClawConfig;  // 配置对象
  entry?: SessionEntry;  // 会话条目
  sessionKey?: string;  // 会话键
  channel?: string;  // 渠道
  chatType?: SessionChatType;  // 聊天类型
}): SessionSendPolicyDecision {
  // 首先检查会话条目的覆盖值
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) {
    return override;
  }

  // 获取全局策略
  const policy = params.cfg.session?.sendPolicy;
  if (!policy) {
    return "allow";  // 没有策略则默认允许
  }

  // 规范化各种键
  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = normalizeLowercaseStringOrEmpty(rawSessionKey);
  const strippedSessionKeyNorm = normalizeLowercaseStringOrEmpty(strippedSessionKey);
  
  let channel: string | undefined;
  let chatType: SessionChatType | undefined;
  
  // 获取渠道的函数（延迟计算）
  const getChannel = () => {
    channel ??=
      normalizeMatchValue(params.channel) ??
      normalizeMatchValue(params.entry?.channel) ??
      normalizeMatchValue(params.entry?.lastChannel) ??
      deriveChannelFromKey(params.sessionKey);
    return channel;
  };
  
  // 获取聊天类型的函数（延迟计算）
  const getChatType = () => {
    chatType ??=
      normalizeChatType(params.chatType ?? params.entry?.chatType) ??
      normalizeChatType(deriveChatTypeFromKey(params.sessionKey));
    return chatType;
  };

  let allowedMatch = false;
  // 遍历规则
  for (const rule of policy.rules ?? []) {
    if (!rule) {
      continue;
    }
    // 解析规则操作
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};
    // 规范化匹配条件
    const matchChannel = normalizeMatchValue(match.channel);
    const matchChatType = normalizeChatType(match.chatType);
    const matchPrefix = normalizeMatchValue(match.keyPrefix);
    const matchRawPrefix = normalizeMatchValue(match.rawKeyPrefix);

    // 检查渠道条件
    if (matchChannel && matchChannel !== getChannel()) {
      continue;
    }
    // 检查聊天类型条件
    if (matchChatType && matchChatType !== getChatType()) {
      continue;
    }
    // 检查原始键前缀条件
    if (matchRawPrefix && !rawSessionKeyNorm.startsWith(matchRawPrefix)) {
      continue;
    }
    // 检查键前缀条件
    if (
      matchPrefix &&
      !rawSessionKeyNorm.startsWith(matchPrefix) &&
      !strippedSessionKeyNorm.startsWith(matchPrefix)
    ) {
      continue;
    }
    // 如果是拒绝规则，立即返回拒绝
    if (action === "deny") {
      return "deny";
    }
    allowedMatch = true;
  }

  // 如果有匹配且允许的规则
  if (allowedMatch) {
    return "allow";
  }

  // 返回默认值
  const fallback = normalizeSendPolicy(policy.default);
  return fallback ?? "allow";
}
