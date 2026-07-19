import { randomBytes } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { InternalChannelThreadingToolContext } from "../channels/threading-tool-context-internal.js";
import type { TurnAuthoritySnapshot } from "../plugins/authorization-policy.types.js";
import { isIssuedTurnAuthoritySnapshot } from "../plugins/turn-authority.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel-normalize.js";

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_CAPABILITIES = 4096;
const RUN_LIFETIME_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
const CAPABILITY_COMPLETION_GRACE_MS = 60_000;

type AgentRuntimeMessageActionContextBase = {
  expiresAtMs: number;
  sessionId?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderIsOwner?: boolean;
  requesterIsAuthorizedSender?: boolean;
  requesterRoleIds?: string[];
  parentConversationId?: string;
  turnAuthority?: TurnAuthoritySnapshot;
  toolContext?: InternalChannelThreadingToolContext;
};

export type AgentRuntimeMessageActionContext = AgentRuntimeMessageActionContextBase &
  (
    | {
        sourceReplyFinal: true;
        sourceReplyToolCallId: string;
      }
    | {
        sourceReplyFinal?: false;
        sourceReplyToolCallId?: string;
      }
  );

type MessageActionTurnCapability = AgentRuntimeMessageActionContext & {
  agentId: string;
  runId: string;
  sessionKey: string;
};

type MessageActionRequesterIdentity = Pick<
  AgentRuntimeMessageActionContextBase,
  | "requesterAccountId"
  | "requesterSenderId"
  | "requesterSenderIsOwner"
  | "requesterIsAuthorizedSender"
  | "requesterRoleIds"
>;

const capabilitiesByToken = new Map<string, MessageActionTurnCapability>();

export function isTrustedMessageActionTurnIngress(provider: string | null | undefined): boolean {
  const normalized = normalizeMessageChannel(provider);
  return normalized !== undefined && isDeliverableMessageChannel(normalized);
}

function resolveTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.trunc(value), MAX_TTL_MS);
}

/** Mirrors agent timeout semantics while leaving unlimited runs to explicit revocation. */
export function resolveMessageActionTurnCapabilityLifetime(
  timeoutMs: number,
): { expiresWithRun: true } | { ttlMs: number } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { expiresWithRun: true };
  }
  const ttlMs = timeoutMs + CAPABILITY_COMPLETION_GRACE_MS;
  // The bounded capability store still caps caller-provided TTLs. A legitimate
  // long turn instead follows the run lifecycle and is revoked on completion.
  return ttlMs > MAX_TTL_MS ? { expiresWithRun: true } : { ttlMs };
}

function copyToolContext(
  context: InternalChannelThreadingToolContext | undefined,
): InternalChannelThreadingToolContext | undefined {
  if (!context) {
    return undefined;
  }
  return {
    currentChannelId: normalizeOptionalString(context.currentChannelId),
    currentChatType: context.currentChatType,
    currentMessagingTarget: normalizeOptionalString(context.currentMessagingTarget),
    currentGraphChannelId: normalizeOptionalString(context.currentGraphChannelId),
    currentChannelProvider: context.currentChannelProvider,
    currentThreadTs: normalizeOptionalString(context.currentThreadTs),
    currentMessageId: context.currentMessageId,
    currentSourceTurnId: normalizeOptionalString(context.currentSourceTurnId),
    replyToMode: context.replyToMode,
    // Reply-to-first state is intentionally shared across actions in one turn.
    // Preserve only this trusted process-local mutable reference.
    hasRepliedRef: context.hasRepliedRef,
    sameChannelThreadRequired: context.sameChannelThreadRequired,
    skipCrossContextDecoration: context.skipCrossContextDecoration,
  };
}

function resolveMessageActionRequesterIdentity(params: {
  turnAuthority?: TurnAuthoritySnapshot;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderIsOwner?: boolean;
  requesterIsAuthorizedSender?: boolean;
  requesterRoleIds?: readonly string[];
}): MessageActionRequesterIdentity {
  const principal = params.turnAuthority?.authorization.principal;
  if (!principal) {
    const requesterRoleIds = normalizeSortedUniqueStringEntries(params.requesterRoleIds ?? []);
    return {
      requesterAccountId: normalizeOptionalString(params.requesterAccountId),
      requesterSenderId: normalizeOptionalString(params.requesterSenderId),
      ...(params.requesterSenderIsOwner !== undefined
        ? { requesterSenderIsOwner: params.requesterSenderIsOwner }
        : {}),
      ...(params.requesterIsAuthorizedSender !== undefined
        ? { requesterIsAuthorizedSender: params.requesterIsAuthorizedSender }
        : {}),
      ...(requesterRoleIds.length > 0 ? { requesterRoleIds } : {}),
    };
  }
  if (principal.kind === "sender") {
    const requesterRoleIds = normalizeSortedUniqueStringEntries(principal.roleIds ?? []);
    return {
      requesterAccountId: principal.accountId,
      requesterSenderId: principal.senderId,
      ...(principal.senderIsOwner !== undefined
        ? { requesterSenderIsOwner: principal.senderIsOwner }
        : {}),
      ...(principal.isAuthorizedSender !== undefined
        ? { requesterIsAuthorizedSender: principal.isAuthorizedSender }
        : {}),
      ...(requesterRoleIds.length > 0 ? { requesterRoleIds } : {}),
    };
  }
  if (principal.kind === "operator") {
    return principal.isOwner === undefined ? {} : { requesterSenderIsOwner: principal.isOwner };
  }
  if (principal.kind === "unknown") {
    return {
      requesterAccountId: principal.accountId,
      requesterSenderIsOwner: false,
    };
  }
  return { requesterSenderIsOwner: false };
}

function evictOldestCapability(): void {
  const oldest = capabilitiesByToken.keys().next().value;
  if (typeof oldest === "string") {
    capabilitiesByToken.delete(oldest);
  }
}

function sweepExpiredMessageActionTurnCapabilities(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [token, capability] of capabilitiesByToken) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Mint an opaque current-turn capability from trusted channel ingress.
 * Public Gateway agent requests never receive this token.
 */
export function mintMessageActionTurnCapability(params: {
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderIsOwner?: boolean;
  requesterIsAuthorizedSender?: boolean;
  requesterRoleIds?: readonly string[];
  parentConversationId?: string;
  turnAuthority?: TurnAuthoritySnapshot;
  toolContext?: InternalChannelThreadingToolContext;
  expiresWithRun?: boolean;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const runId = params.runId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!agentId || !runId || !sessionKey) {
    throw new Error("message action turn capability requires agent, run, and session identity");
  }
  const nowMs = params.nowMs ?? Date.now();
  const sessionId = normalizeOptionalString(params.sessionId);
  if (params.turnAuthority !== undefined && !isIssuedTurnAuthoritySnapshot(params.turnAuthority)) {
    throw new Error("message action turn capability requires host-issued turn authority");
  }
  const turnAuthority = params.turnAuthority;
  if (turnAuthority) {
    const authorization = turnAuthority.authorization;
    if (
      normalizeAgentId(authorization.agentId) !== agentId ||
      authorization.runId !== runId ||
      authorization.sessionKey !== sessionKey ||
      normalizeOptionalString(authorization.sessionId) !== sessionId
    ) {
      throw new Error("message action turn authority does not match execution identity");
    }
  }
  // Signed authority is canonical. Legacy siblings apply only when no issued
  // principal exists, so callers cannot combine identities across trust paths.
  const requesterIdentity = resolveMessageActionRequesterIdentity({
    turnAuthority,
    requesterAccountId: params.requesterAccountId,
    requesterSenderId: params.requesterSenderId,
    requesterSenderIsOwner: params.requesterSenderIsOwner,
    requesterIsAuthorizedSender: params.requesterIsAuthorizedSender,
    requesterRoleIds: params.requesterRoleIds,
  });
  const token = randomBytes(32).toString("base64url");
  const capability: MessageActionTurnCapability = {
    agentId,
    runId,
    sessionKey,
    expiresAtMs: params.expiresWithRun
      ? RUN_LIFETIME_EXPIRES_AT_MS
      : nowMs + resolveTtlMs(params.ttlMs),
    sessionId,
    ...requesterIdentity,
    parentConversationId: normalizeOptionalString(params.parentConversationId),
    ...(turnAuthority ? { turnAuthority } : {}),
    toolContext: copyToolContext(params.toolContext),
  };

  // Finish every fallible validation and normalization before mutating the
  // bounded shared store; a rejected mint must not evict another live turn.
  sweepExpiredMessageActionTurnCapabilities(nowMs);
  while (capabilitiesByToken.size >= MAX_ACTIVE_CAPABILITIES) {
    // A bounded fail-closed store prevents abandoned long-running turns from
    // growing process memory without creating a second persistent state path.
    evictOldestCapability();
  }
  capabilitiesByToken.set(token, capability);
  return token;
}

export function resolveMessageActionTurnCapability(params: {
  token?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  nowMs?: number;
}): AgentRuntimeMessageActionContext | undefined {
  const token = params.token?.trim();
  if (!token) {
    return undefined;
  }
  const capability = capabilitiesByToken.get(token);
  if (!capability) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  if (nowMs >= capability.expiresAtMs) {
    capabilitiesByToken.delete(token);
    return undefined;
  }
  if (
    capability.agentId !== normalizeAgentId(params.agentId) ||
    capability.runId !== params.runId?.trim() ||
    capability.sessionKey !== params.sessionKey.trim() ||
    capability.sessionId !== normalizeOptionalString(params.sessionId)
  ) {
    return undefined;
  }
  return {
    expiresAtMs: capability.expiresAtMs,
    sessionId: capability.sessionId,
    requesterAccountId: capability.requesterAccountId,
    requesterSenderId: capability.requesterSenderId,
    requesterSenderIsOwner: capability.requesterSenderIsOwner,
    requesterIsAuthorizedSender: capability.requesterIsAuthorizedSender,
    requesterRoleIds: capability.requesterRoleIds ? [...capability.requesterRoleIds] : undefined,
    parentConversationId: capability.parentConversationId,
    turnAuthority: capability.turnAuthority,
    toolContext: copyToolContext(capability.toolContext),
  };
}

export function revokeMessageActionTurnCapability(token: string | undefined): boolean {
  return token ? capabilitiesByToken.delete(token) : false;
}
