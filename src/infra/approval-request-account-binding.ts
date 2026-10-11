// Matches approval requests against channel account and session bindings.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.read.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";
import {
  resolveApprovalRequestKind,
  type ApprovalRequestChannelRouteClass,
  type ApprovalRequestInput,
} from "./approval-types.js";

export type ApprovalRequestLike = Pick<
  ApprovalRequestInput,
  "id" | "request" | "createdAtMs" | "expiresAtMs"
>;

function resolveApprovalForwardTargets(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}) {
  const forwarding =
    resolveApprovalRequestKind(params.request) === "exec"
      ? params.cfg.approvals?.exec
      : params.cfg.approvals?.plugin;
  const channel = normalizeMessageChannel(params.channel);
  if (!forwarding?.enabled || (forwarding.mode !== "targets" && forwarding.mode !== "both")) {
    return [];
  }
  if (
    !matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: forwarding.agentFilter,
      sessionFilter: forwarding.sessionFilter,
    })
  ) {
    return [];
  }
  return (forwarding.targets ?? []).filter(
    (target) => normalizeMessageChannel(target.channel) === channel,
  );
}

function resolveApprovalForwardAccountIds(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
  defaultAccountId?: string | null;
}): string[] {
  return resolveApprovalForwardTargets(params).flatMap((target) => {
    const accountId = normalizeOptionalAccountId(target.accountId ?? params.defaultAccountId);
    return accountId ? [accountId] : [];
  });
}

/** Classifies whether native delivery has named channel-account owners. */
export function classifyApprovalRequestChannelRoute(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  defaultAccountId?: string | null;
}): ApprovalRequestChannelRouteClass {
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (!expectedChannel) {
    return "unbound";
  }
  if (resolveApprovalRequestChannelAccountId(params)) {
    return "bound-or-explicit";
  }
  if (resolveApprovalForwardTargets(params).length > 0) {
    return "bound-or-explicit";
  }
  return "unbound";
}

/** Reads only the current session facts consumed by synchronous approval routing. */
export function resolveApprovalRequestSessionDelivery(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): Pick<SessionEntry, "sessionId" | "updatedAt" | "delivery"> | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const binding = captureIncognitoSessionBinding({ storePath, sessionKey });
  if (binding) {
    binding.admissionSignal?.throwIfAborted();
    binding.actor.assertReadable();
    return binding.actor.sessions.readDelivery(sessionKey) ?? null;
  }
  const entry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  if (!entry) {
    return null;
  }
  return { sessionId: entry.sessionId, updatedAt: entry.updatedAt, delivery: entry.delivery };
}

function resolvePersistedApprovalRequestSessionBinding(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}) {
  const entry = resolveApprovalRequestSessionDelivery(params);
  if (!entry) {
    return null;
  }
  const origin = sessionDeliveryOrigin(entry);
  const context = deliveryContextFromSession(entry);
  const channel = normalizeMessageChannel(context?.channel ?? origin?.provider);
  const accountId = normalizeOptionalAccountId(context?.accountId ?? origin?.accountId);
  return channel || accountId ? { channel, accountId } : null;
}

// A missing binding can match any account; a conflicting channel cannot.
function resolveApprovalRequestAccountBinding(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): { accountId: string | null } | null {
  const expectedChannel = normalizeMessageChannel(params.channel);
  const turnSourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  if (expectedChannel && turnSourceChannel && turnSourceChannel !== expectedChannel) {
    return null;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  if (turnSourceAccountId) {
    return { accountId: turnSourceAccountId };
  }

  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  const sessionChannel = sessionBinding?.channel;
  if (expectedChannel && sessionChannel && sessionChannel !== expectedChannel) {
    return null;
  }

  return { accountId: sessionBinding?.accountId ?? null };
}

/** Resolves the account id an approval request belongs to for an optional channel filter. */
export function resolveApprovalRequestAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): string | null {
  return resolveApprovalRequestAccountBinding(params)?.accountId ?? null;
}

/** Resolves an approval request account only when the request can be routed to a channel. */
export function resolveApprovalRequestChannelAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
}): string | null {
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (!expectedChannel) {
    return null;
  }
  const turnSourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  if (!turnSourceChannel || turnSourceChannel === expectedChannel) {
    return resolveApprovalRequestAccountId(params);
  }

  // A conflicting turn-source channel is authoritative for live routing; only
  // fall back to the persisted session when that stored binding names this channel.
  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  return sessionBinding?.channel === expectedChannel ? (sessionBinding.accountId ?? null) : null;
}

/** Checks whether a channel/account pair is eligible to handle an approval request. */
export function doesApprovalRequestMatchChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
}): boolean {
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (!expectedChannel) {
    return false;
  }

  const binding = resolveApprovalRequestAccountBinding(params);
  if (!binding) {
    return false;
  }
  const expectedAccountId = normalizeOptionalAccountId(params.accountId);
  return !expectedAccountId || !binding.accountId || expectedAccountId === binding.accountId;
}

/** Selects the one channel account that owns a native approval request. */
export function doesApprovalRequestSelectChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
  defaultAccountId: string;
  eligibleAccountIds: readonly string[];
}): boolean {
  const accountId =
    normalizeOptionalAccountId(params.accountId) ??
    normalizeOptionalAccountId(params.defaultAccountId);
  if (!accountId) {
    return false;
  }
  const boundAccountId = resolveApprovalRequestChannelAccountId(params);
  if (accountId === normalizeOptionalAccountId(boundAccountId)) {
    return true;
  }
  const forwardAccountIds = resolveApprovalForwardAccountIds(params);
  if (forwardAccountIds.includes(accountId)) {
    return true;
  }
  if (boundAccountId || forwardAccountIds.length > 0) {
    return false;
  }
  const turnSourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== normalizeMessageChannel(params.channel)) {
    return false;
  }
  const eligibleAccountIds = params.eligibleAccountIds
    .map(normalizeOptionalAccountId)
    .filter((candidate): candidate is string => Boolean(candidate));
  return eligibleAccountIds.length === 1 && eligibleAccountIds[0] === accountId;
}
