import type { SessionSendPolicyConfig } from "../config/types.base.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import type { ContinuitySourceClass } from "./types.js";

type ParsedContinuityScope = {
  channel?: string;
  chatType?: "channel" | "group" | "direct";
  normalizedKey?: string;
};

const CONTINUITY_CHAT_TYPE_MARKERS = new Set(["group", "channel", "direct", "dm"]);

export function isContinuitySubagentSession(sessionKey?: string): boolean {
  const normalized = normalizeSessionRest(sessionKey);
  return Boolean(normalized?.startsWith("subagent:"));
}

export function classifyContinuitySource(sessionKey?: string): ContinuitySourceClass {
  const rest = normalizeSessionRest(sessionKey) ?? "";
  if (rest.startsWith("subagent:")) {
    // Treat internal subagent runs as non-direct so continuity capture stays disabled.
    return "channel";
  }
  const parsed = parseContinuitySessionScope(sessionKey);
  if (parsed.chatType === "group") {
    return "group";
  }
  if (parsed.chatType === "channel") {
    return "channel";
  }
  if (!rest || rest === "main") {
    return "main_direct";
  }
  if (parsed.chatType === "direct") {
    return "paired_direct";
  }
  // Unknown session keys (cron/internal/background) should never be treated as direct.
  return "channel";
}

export function isContinuityScopeAllowed(
  scope: SessionSendPolicyConfig | undefined,
  sessionKey?: string,
): boolean {
  if (!scope) {
    return true;
  }
  const parsed = parseContinuitySessionScope(sessionKey);
  const channel = parsed.channel;
  const chatType = parsed.chatType;
  const normalizedKey = parsed.normalizedKey ?? "";
  const rawKey = sessionKey?.trim().toLowerCase() ?? "";
  for (const rule of scope.rules ?? []) {
    if (!rule) {
      continue;
    }
    const match = rule.match ?? {};
    if (match.channel && match.channel !== channel) {
      continue;
    }
    if (match.chatType && match.chatType !== chatType) {
      continue;
    }
    const normalizedPrefix = match.keyPrefix?.trim().toLowerCase() || undefined;
    const rawPrefix = match.rawKeyPrefix?.trim().toLowerCase() || undefined;
    if (rawPrefix && !rawKey.startsWith(rawPrefix)) {
      continue;
    }
    if (normalizedPrefix) {
      const isLegacyRaw = normalizedPrefix.startsWith("agent:");
      if (isLegacyRaw) {
        if (!rawKey.startsWith(normalizedPrefix)) {
          continue;
        }
      } else if (!normalizedKey.startsWith(normalizedPrefix)) {
        continue;
      }
    }
    return rule.action === "allow";
  }
  return (scope.default ?? "allow") === "allow";
}

function parseContinuitySessionScope(key?: string): ParsedContinuityScope {
  const normalized = normalizeSessionKey(key);
  if (!normalized) {
    return {};
  }
  const parts = normalized.split(":").filter(Boolean);
  const chatTypeIndex = parts.findIndex((part) => CONTINUITY_CHAT_TYPE_MARKERS.has(part));
  const channel = resolveChannel(parts);
  if (chatTypeIndex >= 0) {
    const marker = parts[chatTypeIndex];
    const chatType = marker === "group" ? "group" : marker === "channel" ? "channel" : "direct";
    return {
      normalizedKey: normalized,
      channel,
      chatType,
    };
  }
  return { normalizedKey: normalized, channel };
}

function normalizeSessionKey(key?: string): string | undefined {
  const normalized = normalizeSessionRest(key);
  if (!normalized || normalized.startsWith("subagent:")) {
    return undefined;
  }
  return normalized;
}

function normalizeSessionRest(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(trimmed);
  const normalized = (parsed?.rest ?? trimmed).toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function resolveChannel(parts: string[]): string | undefined {
  const channel = parts[0]?.toLowerCase();
  if (!channel || channel === "main") {
    return undefined;
  }
  if (CONTINUITY_CHAT_TYPE_MARKERS.has(channel)) {
    return undefined;
  }
  return channel;
}
