import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionDeliveryChannel } from "../utils/delivery-context.read.js";
import {
  hasAmbiguousCanonicalSessionPeerShape,
  parseCanonicalSessionPeerShape,
} from "./session-chat-type-shared.js";
import { deriveSessionChatType } from "./session-chat-type.js";

/** Session send-policy decision after config and per-session overrides are evaluated. */
export type SessionSendPolicyDecision = "allow" | "deny";

/** Normalizes raw send-policy text into a decision. */
export function normalizeSendPolicy(raw?: string | null): SessionSendPolicyDecision | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  return value === "allow" || value === "deny" ? value : undefined;
}

function stripAgentSessionKeyPrefix(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const parts = key.split(":");
  // Canonical agent session keys: agent:<agentId>:<sessionKey...>
  if (parts[0] === "agent") {
    if (parts.length < 3 || !parts[1] || !parts[2]) {
      return undefined;
    }
    return parts.slice(2).join(":");
  }
  return key;
}

function deriveChatTypeFromKey(normalizedKey: string): SessionChatType | undefined {
  if (!normalizedKey || normalizedKey.startsWith("agent:")) {
    return undefined;
  }
  const derived = deriveSessionChatType(normalizedKey);
  return derived !== "unknown" ? derived : undefined;
}

/** Resolves whether a session send is allowed by entry override and config rules. */
export function resolveSendPolicy(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
}): SessionSendPolicyDecision {
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) {
    return override;
  }

  const policy = params.cfg.session?.sendPolicy;
  if (!policy) {
    return "allow";
  }
  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = normalizeLowercaseStringOrEmpty(rawSessionKey);
  const strippedSessionKeyNorm = normalizeLowercaseStringOrEmpty(strippedSessionKey);
  // The legacy key grammar cannot distinguish a peer-kind-shaped account id
  // from a channel peer. Never let that ambiguity satisfy an allow policy.
  if (strippedSessionKeyNorm && hasAmbiguousCanonicalSessionPeerShape(strippedSessionKeyNorm)) {
    return "deny";
  }
  let channel: string | undefined;
  let chatType: SessionChatType | undefined;
  const getChannel = () => {
    channel ??=
      normalizeOptionalLowercaseString(params.channel) ??
      normalizeOptionalLowercaseString(sessionDeliveryChannel(params.entry)) ??
      normalizeOptionalLowercaseString(parseCanonicalSessionPeerShape(strippedSessionKey)?.channel);
    return channel;
  };
  const getChatType = () => {
    chatType ??=
      normalizeChatType(params.chatType ?? params.entry?.chatType) ??
      normalizeChatType(deriveChatTypeFromKey(strippedSessionKeyNorm));
    return chatType;
  };

  let allowedMatch = false;
  for (const rule of policy.rules ?? []) {
    if (!rule) {
      continue;
    }
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchChannel = normalizeOptionalLowercaseString(match.channel);
    const matchChatType = normalizeChatType(match.chatType);
    const matchPrefix = normalizeOptionalLowercaseString(match.keyPrefix);
    const matchRawPrefix = normalizeOptionalLowercaseString(match.rawKeyPrefix);

    if (matchChannel && matchChannel !== getChannel()) {
      continue;
    }
    if (matchChatType && matchChatType !== getChatType()) {
      continue;
    }
    if (matchRawPrefix && !rawSessionKeyNorm.startsWith(matchRawPrefix)) {
      continue;
    }
    if (
      matchPrefix &&
      !rawSessionKeyNorm.startsWith(matchPrefix) &&
      !strippedSessionKeyNorm.startsWith(matchPrefix)
    ) {
      continue;
    }
    if (action === "deny") {
      return "deny";
    }
    allowedMatch = true;
  }

  if (allowedMatch) {
    return "allow";
  }

  const fallback = normalizeSendPolicy(policy.default);
  return fallback ?? "allow";
}
