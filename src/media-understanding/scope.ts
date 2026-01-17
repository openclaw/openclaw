import type { MediaUnderstandingScopeConfig } from "../config/types.tools.js";

export type MediaUnderstandingScopeDecision = "allow" | "deny";

function normalizeDecision(value?: string | null): MediaUnderstandingScopeDecision | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "allow") return "allow";
  if (normalized === "deny") return "deny";
  return undefined;
}

function normalizeMatch(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function normalizeMediaUnderstandingChatType(raw?: string | null): string | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "dm" || value === "direct_message" || value === "private") return "direct";
  if (value === "groups") return "group";
  if (value === "room") return "channel";
  return value;
}

export function resolveMediaUnderstandingScope(params: {
  scope?: MediaUnderstandingScopeConfig;
  sessionKey?: string;
  channel?: string;
  chatType?: string;
}): MediaUnderstandingScopeDecision {
  const scope = params.scope;
  if (!scope) return "allow";

  const channel = normalizeMatch(params.channel);
  const chatType = normalizeMediaUnderstandingChatType(params.chatType) ?? normalizeMatch(params.chatType);
  const sessionKey = normalizeMatch(params.sessionKey) ?? "";

  for (const rule of scope.rules ?? []) {
    if (!rule) continue;
    const action = normalizeDecision(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchChannel = normalizeMatch(match.channel);
    const matchChatType =
      normalizeMediaUnderstandingChatType(match.chatType) ?? normalizeMatch(match.chatType);
    const matchPrefix = normalizeMatch(match.keyPrefix);

    if (matchChannel && matchChannel !== channel) continue;
    if (matchChatType && matchChatType !== chatType) continue;
    if (matchPrefix && !sessionKey.startsWith(matchPrefix)) continue;
    return action;
  }

  return normalizeDecision(scope.default) ?? "allow";
}
