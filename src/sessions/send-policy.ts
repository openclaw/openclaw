import type { ClawdisConfig } from "../config/config.js";
import type { SessionEntry, SessionChatType } from "../config/sessions.js";

export type SessionSendPolicyDecision = "allow" | "deny";

export function normalizeSendPolicy(
  raw?: string | null,
): SessionSendPolicyDecision | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "allow") return "allow";
  if (value === "deny") return "deny";
  return undefined;
}

function normalizeMatchValue(raw?: string | null) {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

function deriveSurfaceFromKey(key?: string) {
  if (!key) return undefined;
  const parts = key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return normalizeMatchValue(parts[0]);
  }
  return undefined;
}

function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  if (!key) return undefined;
  if (key.startsWith("group:") || key.includes(":group:")) return "group";
  if (key.includes(":channel:")) return "room";
  return undefined;
}

export function resolveSendPolicy(params: {
  cfg: ClawdisConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  surface?: string;
  chatType?: SessionChatType;
}): SessionSendPolicyDecision {
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) return override;

  const policy = params.cfg.session?.sendPolicy;
  if (!policy) return "allow";

  const surface =
    normalizeMatchValue(params.surface) ??
    normalizeMatchValue(params.entry?.surface) ??
    normalizeMatchValue(params.entry?.lastChannel) ??
    deriveSurfaceFromKey(params.sessionKey);
  const chatType =
    normalizeMatchValue(params.chatType ?? params.entry?.chatType) ??
    normalizeMatchValue(deriveChatTypeFromKey(params.sessionKey));
  const sessionKey = params.sessionKey ?? "";

  let allowedMatch = false;
  for (const rule of policy.rules ?? []) {
    if (!rule) continue;
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchSurface = normalizeMatchValue(match.surface);
    const matchChatType = normalizeMatchValue(match.chatType);
    const matchPrefix = normalizeMatchValue(match.keyPrefix);

    if (matchSurface && matchSurface !== surface) continue;
    if (matchChatType && matchChatType !== chatType) continue;
    if (matchPrefix && !sessionKey.startsWith(matchPrefix)) continue;
    if (action === "deny") return "deny";
    allowedMatch = true;
  }

  if (allowedMatch) return "allow";

  const fallback = normalizeSendPolicy(policy.default);
  return fallback ?? "allow";
}
