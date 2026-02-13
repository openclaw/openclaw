import type { ResolvedQmdConfig } from "./backend-config.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

export function isQmdScopeAllowed(scope: ResolvedQmdConfig["scope"], sessionKey?: string): boolean {
  if (!scope) {
    return true;
  }
  const channel = deriveQmdScopeChannel(sessionKey);
  const chatType = deriveQmdScopeChatType(sessionKey);
  const normalizedKey = sessionKey ?? "";
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
    if (match.keyPrefix && !normalizedKey.startsWith(match.keyPrefix)) {
      continue;
    }
    return rule.action === "allow";
  }
  const fallback = scope.default ?? "allow";
  return fallback === "allow";
}

export function deriveQmdScopeChannel(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const normalized = normalizeQmdSessionKey(key);
  if (!normalized) {
    return undefined;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (
    parts.length >= 2 &&
    (parts[1] === "group" || parts[1] === "channel" || parts[1] === "direct" || parts[1] === "dm")
  ) {
    return parts[0]?.toLowerCase();
  }
  return undefined;
}

export function deriveQmdScopeChatType(key?: string): "channel" | "group" | "direct" | undefined {
  if (!key) {
    return undefined;
  }
  const normalized = normalizeQmdSessionKey(key);
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes(":group:")) {
    return "group";
  }
  if (normalized.includes(":channel:")) {
    return "channel";
  }
  return "direct";
}

function normalizeQmdSessionKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(trimmed);
  const normalized = (parsed?.rest ?? trimmed).toLowerCase();
  if (normalized.startsWith("subagent:")) {
    return undefined;
  }
  return normalized;
}
