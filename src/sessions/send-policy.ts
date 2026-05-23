import { normalizeChatType } from "../channels/chat-type.js";
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import type { SessionSendPolicyMatch } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { deriveSessionChatType } from "./session-chat-type.js";

export type SessionSendPolicyDecision = "allow" | "deny";

export type SessionSendPolicyCancelReason = {
  code: "send_policy_peer_mismatch";
  peerEquals: "inboundPeer";
  expectedPeer?: string;
  expectedPeers?: string[];
  actualPeer?: string;
};

export type SessionSendPolicyResult =
  | { decision: "allow" }
  | { decision: "deny"; cancelReason?: SessionSendPolicyCancelReason };

type MatchEvaluation = {
  matches: boolean;
  cancelReason?: SessionSendPolicyCancelReason;
};

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

function normalizeMatchValue(raw?: string | null) {
  const value = normalizeOptionalLowercaseString(raw);
  return value ? value : undefined;
}

function normalizePeer(raw?: string | null): string | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  return value ? value : undefined;
}

function normalizePeerList(raw?: string | readonly string[] | null): string[] {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const peers: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const peer = normalizePeer(value);
    if (!peer || seen.has(peer)) {
      continue;
    }
    peers.push(peer);
    seen.add(peer);
  }
  return peers;
}

function stripAgentSessionKeyPrefix(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const parts = key.split(":").filter(Boolean);
  // Canonical agent session keys: agent:<agentId>:<sessionKey...>
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return key;
}

function deriveChannelFromKey(key?: string) {
  const normalizedKey = stripAgentSessionKeyPrefix(key);
  if (!normalizedKey) {
    return undefined;
  }
  const parts = normalizedKey.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return normalizeMatchValue(parts[0]);
  }
  return undefined;
}

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
  const derived = deriveSessionChatType(normalizedKey);
  if (derived !== "unknown") {
    return derived;
  }
  return undefined;
}

function createPeerMismatchReason(params: {
  expectedPeers: readonly string[];
  actualPeer?: string;
}): SessionSendPolicyCancelReason {
  return {
    code: "send_policy_peer_mismatch",
    peerEquals: "inboundPeer",
    ...(params.expectedPeers[0] ? { expectedPeer: params.expectedPeers[0] } : {}),
    ...(params.expectedPeers.length > 0 ? { expectedPeers: [...params.expectedPeers] } : {}),
    ...(params.actualPeer ? { actualPeer: params.actualPeer } : {}),
  };
}

function evaluateSendPolicyMatch(params: {
  match: SessionSendPolicyMatch;
  rawSessionKeyNorm: string;
  strippedSessionKeyNorm: string;
  getChannel: () => string | undefined;
  getChatType: () => SessionChatType | undefined;
  getInboundPeers: () => readonly string[];
  getOutboundPeer: () => string | undefined;
}): MatchEvaluation {
  const match = params.match;
  const matchChannel = normalizeMatchValue(match.channel);
  const matchChatType = normalizeChatType(match.chatType);
  const matchPrefix = normalizeMatchValue(match.keyPrefix);
  const matchRawPrefix = normalizeMatchValue(match.rawKeyPrefix);

  let matches = true;
  let cancelReason: SessionSendPolicyCancelReason | undefined;

  if (matchChannel && matchChannel !== params.getChannel()) {
    matches = false;
  }
  if (matches && matchChatType && matchChatType !== params.getChatType()) {
    matches = false;
  }
  if (matches && matchRawPrefix && !params.rawSessionKeyNorm.startsWith(matchRawPrefix)) {
    matches = false;
  }
  if (
    matches &&
    matchPrefix &&
    !params.rawSessionKeyNorm.startsWith(matchPrefix) &&
    !params.strippedSessionKeyNorm.startsWith(matchPrefix)
  ) {
    matches = false;
  }

  if (matches && match.peerEquals === "inboundPeer") {
    const actualPeer = params.getOutboundPeer();
    const expectedPeers = params.getInboundPeers();

    // Missing peer context means this relational predicate is not applicable.
    // Do not let inverted peer checks deny cron, heartbeat, or internal turns.
    if (!actualPeer || expectedPeers.length === 0) {
      return { matches: false };
    }

    const peerMatched = expectedPeers.includes(actualPeer);
    if (!peerMatched) {
      cancelReason = createPeerMismatchReason({ expectedPeers, actualPeer });
    }
    matches &&= peerMatched;
  }

  if (matches && match.allOf) {
    for (const child of match.allOf) {
      const childResult = evaluateSendPolicyMatch({ ...params, match: child });
      if (!childResult.matches) {
        matches = false;
        break;
      }
      cancelReason ??= childResult.cancelReason;
    }
  }

  if (matches && match.anyOf && match.anyOf.length > 0) {
    let anyMatched = false;
    for (const child of match.anyOf) {
      const childResult = evaluateSendPolicyMatch({ ...params, match: child });
      if (childResult.matches) {
        anyMatched = true;
        cancelReason ??= childResult.cancelReason;
        break;
      }
    }
    matches &&= anyMatched;
  }

  const finalMatches = match.invert === true ? !matches : matches;
  return {
    matches: finalMatches,
    ...(finalMatches && match.invert === true && cancelReason ? { cancelReason } : {}),
  };
}

export function resolveSendPolicyDetailed(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
  inboundPeer?: string | readonly string[];
  outboundPeer?: string;
}): SessionSendPolicyResult {
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) {
    return { decision: override };
  }

  const policy = params.cfg.session?.sendPolicy;
  if (!policy) {
    return { decision: "allow" };
  }

  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = normalizeLowercaseStringOrEmpty(rawSessionKey);
  const strippedSessionKeyNorm = normalizeLowercaseStringOrEmpty(strippedSessionKey);
  let channel: string | undefined;
  let chatType: SessionChatType | undefined;
  let inboundPeers: string[] | undefined;
  let outboundPeer: string | undefined;
  const getChannel = () => {
    channel ??=
      normalizeMatchValue(params.channel) ??
      normalizeMatchValue(params.entry?.channel) ??
      normalizeMatchValue(params.entry?.lastChannel) ??
      deriveChannelFromKey(params.sessionKey);
    return channel;
  };
  const getChatType = () => {
    chatType ??=
      normalizeChatType(params.chatType ?? params.entry?.chatType) ??
      normalizeChatType(deriveChatTypeFromKey(params.sessionKey));
    return chatType;
  };
  const getInboundPeers = () => {
    inboundPeers ??= normalizePeerList(params.inboundPeer);
    return inboundPeers;
  };
  const getOutboundPeer = () => {
    outboundPeer ??= normalizePeer(params.outboundPeer);
    return outboundPeer;
  };

  let allowedMatch = false;
  for (const rule of policy.rules ?? []) {
    if (!rule) {
      continue;
    }
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchResult = evaluateSendPolicyMatch({
      match,
      rawSessionKeyNorm,
      strippedSessionKeyNorm,
      getChannel,
      getChatType,
      getInboundPeers,
      getOutboundPeer,
    });

    if (!matchResult.matches) {
      continue;
    }
    if (action === "deny") {
      return {
        decision: "deny",
        ...(matchResult.cancelReason ? { cancelReason: matchResult.cancelReason } : {}),
      };
    }
    allowedMatch = true;
  }

  if (allowedMatch) {
    return { decision: "allow" };
  }

  const fallback = normalizeSendPolicy(policy.default);
  return { decision: fallback ?? "allow" };
}

export function resolveSendPolicy(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
  inboundPeer?: string | readonly string[];
  outboundPeer?: string;
}): SessionSendPolicyDecision {
  return resolveSendPolicyDetailed(params).decision;
}
