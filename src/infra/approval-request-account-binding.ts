import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
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

type ApprovalRequestParams = {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
};

function resolveApprovalForwardTargets(
  params: ApprovalRequestParams & {
    channel?: string | null;
  },
) {
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

function resolveApprovalForwardAccountIds(
  params: ApprovalRequestParams & {
    channel?: string | null;
    defaultAccountId?: string | null;
  },
): string[] {
  return resolveApprovalForwardTargets(params).flatMap((target) => {
    const accountId = normalizeOptionalAccountId(target.accountId ?? params.defaultAccountId);
    return accountId ? [accountId] : [];
  });
}

type ApprovalRequestSessionParams = ApprovalRequestParams & {
  sessionDelivery?: ApprovalRequestSessionDelivery | null;
};

export type ApprovalRequestSessionDelivery = Pick<
  SessionEntry,
  "sessionId" | "updatedAt" | "delivery"
>;

function approvalRequestSessionDelivery(
  entry: ApprovalRequestSessionDelivery | null | undefined,
): ApprovalRequestSessionDelivery | null {
  return entry
    ? { sessionId: entry.sessionId, updatedAt: entry.updatedAt, delivery: entry.delivery }
    : null;
}

/** Classifies whether native delivery has named channel-account owners. */
export async function classifyApprovalRequestChannelRouteAsync(
  params: ApprovalRequestParams & {
    channel: string;
  },
): Promise<ApprovalRequestChannelRouteClass> {
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (!expectedChannel) {
    return "unbound";
  }
  if (await resolveApprovalRequestChannelAccountIdAsync(params)) {
    return "bound-or-explicit";
  }
  if (resolveApprovalForwardTargets(params).length > 0) {
    return "bound-or-explicit";
  }
  return "unbound";
}

/** Compatibility reader retained only by the deprecated synchronous Plugin SDK. */
function resolveLegacyApprovalRequestSessionDelivery(
  params: ApprovalRequestParams,
): Pick<SessionEntry, "sessionId" | "updatedAt" | "delivery"> | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const memory = captureSessionActorStorageOwner(
    { sessionKey, agentId, storePath },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    const entry =
      memory.binding?.actor.target.sessionKey === sessionKey
        ? memory.binding.actor.snapshot(memory.authority)?.entry
        : memory.owner?.readSession(sessionKey, memory.authority)?.entry;
    return approvalRequestSessionDelivery(entry);
  }
  const entry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  return approvalRequestSessionDelivery(entry);
}

function resolvePersistedApprovalRequestSessionBinding(
  entry: ApprovalRequestSessionDelivery | null,
) {
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
function resolveApprovalRequestAccountBinding(
  params: ApprovalRequestParams & {
    channel?: string | null;
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): { accountId: string | null } | null {
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

  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(sessionDelivery);
  const sessionChannel = sessionBinding?.channel;
  if (expectedChannel && sessionChannel && sessionChannel !== expectedChannel) {
    return null;
  }

  return { accountId: sessionBinding?.accountId ?? null };
}

/** Resolves the account id an approval request belongs to for an optional channel filter. */
function resolveApprovalRequestAccountIdFromDelivery(
  params: ApprovalRequestParams & {
    channel?: string | null;
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): string | null {
  return resolveApprovalRequestAccountBinding(params, sessionDelivery)?.accountId ?? null;
}

/** Resolves an approval request account only when the request can be routed to a channel. */
function resolveApprovalRequestChannelAccountIdFromDelivery(
  params: ApprovalRequestParams & {
    channel: string;
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): string | null {
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (!expectedChannel) {
    return null;
  }
  const turnSourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  if (!turnSourceChannel || turnSourceChannel === expectedChannel) {
    return resolveApprovalRequestAccountIdFromDelivery(params, sessionDelivery);
  }

  // A conflicting turn-source channel is authoritative for live routing; only
  // fall back to the persisted session when that stored binding names this channel.
  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(sessionDelivery);
  return sessionBinding?.channel === expectedChannel ? (sessionBinding.accountId ?? null) : null;
}

/** Checks whether a channel/account pair is eligible to handle an approval request. */
export function doesApprovalRequestMatchChannelAccountFromDelivery(
  params: ApprovalRequestParams & {
    channel: string;
    accountId?: string | null;
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): boolean {
  const expectedChannel = normalizeMessageChannel(params.channel);
  if (!expectedChannel) {
    return false;
  }

  const binding = resolveApprovalRequestAccountBinding(params, sessionDelivery);
  if (!binding) {
    return false;
  }
  const expectedAccountId = normalizeOptionalAccountId(params.accountId);
  return !expectedAccountId || !binding.accountId || expectedAccountId === binding.accountId;
}

/** Selects the one channel account that owns a native approval request. */
export function doesApprovalRequestSelectChannelAccountFromDelivery(
  params: ApprovalRequestParams & {
    channel: string;
    accountId?: string | null;
    defaultAccountId: string;
    eligibleAccountIds: readonly string[];
  },
  sessionDelivery: ApprovalRequestSessionDelivery | null,
): boolean {
  const accountId =
    normalizeOptionalAccountId(params.accountId) ??
    normalizeOptionalAccountId(params.defaultAccountId);
  if (!accountId) {
    return false;
  }
  const boundAccountId = resolveApprovalRequestChannelAccountIdFromDelivery(
    params,
    sessionDelivery,
  );
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

/** Reads one current routing snapshot through the session owner; supplied facts are reused. */
export async function resolveApprovalRequestSessionDeliveryAsync(
  params: ApprovalRequestSessionParams,
): Promise<ApprovalRequestSessionDelivery | null> {
  if (params.sessionDelivery !== undefined) {
    return params.sessionDelivery;
  }
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const agentId =
    parseAgentSessionKey(sessionKey)?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const memory = captureSessionActorStorageOwner(
    { sessionKey, agentId, storePath },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    const entry =
      memory.binding?.actor.target.sessionKey === sessionKey
        ? memory.binding.actor.snapshot(memory.authority)?.entry
        : memory.owner?.readSession(sessionKey, memory.authority)?.entry;
    return approvalRequestSessionDelivery(entry);
  }
  const entry = await readSessionEntryReadOnlyInWorker({
    agentId,
    storePath,
    sessionKey,
    projection: "list",
    hydrateSkillPromptRefs: false,
  });
  return approvalRequestSessionDelivery(entry);
}

function warnLegacyApprovalRouting(name: string): void {
  warnPluginSdkDeprecation({
    family: "approval-session-routing",
    method: name,
    replacement: `${name}Async`,
  });
}

/** @deprecated Use resolveApprovalRequestAccountIdAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveApprovalRequestAccountId(
  params: Parameters<typeof resolveApprovalRequestAccountIdFromDelivery>[0],
): ReturnType<typeof resolveApprovalRequestAccountIdFromDelivery> {
  warnLegacyApprovalRouting("resolveApprovalRequestAccountId");
  return resolveApprovalRequestAccountIdFromDelivery(
    params,
    resolveLegacyApprovalRequestSessionDelivery(params),
  );
}

export async function resolveApprovalRequestAccountIdAsync(
  params: Parameters<typeof resolveApprovalRequestAccountIdFromDelivery>[0] &
    ApprovalRequestSessionParams,
): Promise<ReturnType<typeof resolveApprovalRequestAccountIdFromDelivery>> {
  return resolveApprovalRequestAccountIdFromDelivery(
    params,
    normalizeOptionalAccountId(params.request.request.turnSourceAccountId)
      ? null
      : await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}

/** @deprecated Use resolveApprovalRequestChannelAccountIdAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveApprovalRequestChannelAccountId(
  params: Parameters<typeof resolveApprovalRequestChannelAccountIdFromDelivery>[0],
): ReturnType<typeof resolveApprovalRequestChannelAccountIdFromDelivery> {
  warnLegacyApprovalRouting("resolveApprovalRequestChannelAccountId");
  return resolveApprovalRequestChannelAccountIdFromDelivery(
    params,
    resolveLegacyApprovalRequestSessionDelivery(params),
  );
}

export async function resolveApprovalRequestChannelAccountIdAsync(
  params: Parameters<typeof resolveApprovalRequestChannelAccountIdFromDelivery>[0] &
    ApprovalRequestSessionParams,
): Promise<ReturnType<typeof resolveApprovalRequestChannelAccountIdFromDelivery>> {
  const channel = normalizeMessageChannel(params.channel);
  const sourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  const sourceAccount = normalizeOptionalAccountId(params.request.request.turnSourceAccountId);
  const useSourceAccount = sourceAccount && (!sourceChannel || sourceChannel === channel);
  return resolveApprovalRequestChannelAccountIdFromDelivery(
    params,
    !channel || useSourceAccount ? null : await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}

/** @deprecated Use doesApprovalRequestMatchChannelAccountAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function doesApprovalRequestMatchChannelAccount(
  params: Parameters<typeof doesApprovalRequestMatchChannelAccountFromDelivery>[0],
): ReturnType<typeof doesApprovalRequestMatchChannelAccountFromDelivery> {
  warnLegacyApprovalRouting("doesApprovalRequestMatchChannelAccount");
  return doesApprovalRequestMatchChannelAccountFromDelivery(
    params,
    resolveLegacyApprovalRequestSessionDelivery(params),
  );
}

export async function doesApprovalRequestMatchChannelAccountAsync(
  params: Parameters<typeof doesApprovalRequestMatchChannelAccountFromDelivery>[0] &
    ApprovalRequestSessionParams,
): Promise<ReturnType<typeof doesApprovalRequestMatchChannelAccountFromDelivery>> {
  return doesApprovalRequestMatchChannelAccountFromDelivery(
    params,
    normalizeOptionalAccountId(params.request.request.turnSourceAccountId)
      ? null
      : await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}

/** @deprecated Use doesApprovalRequestSelectChannelAccountAsync; final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function doesApprovalRequestSelectChannelAccount(
  params: Parameters<typeof doesApprovalRequestSelectChannelAccountFromDelivery>[0],
): ReturnType<typeof doesApprovalRequestSelectChannelAccountFromDelivery> {
  warnLegacyApprovalRouting("doesApprovalRequestSelectChannelAccount");
  return doesApprovalRequestSelectChannelAccountFromDelivery(
    params,
    resolveLegacyApprovalRequestSessionDelivery(params),
  );
}

export async function doesApprovalRequestSelectChannelAccountAsync(
  params: Parameters<typeof doesApprovalRequestSelectChannelAccountFromDelivery>[0] &
    ApprovalRequestSessionParams,
): Promise<ReturnType<typeof doesApprovalRequestSelectChannelAccountFromDelivery>> {
  const channel = normalizeMessageChannel(params.channel);
  const sourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  const sourceAccount = normalizeOptionalAccountId(params.request.request.turnSourceAccountId);
  const useSourceAccount = sourceAccount && (!sourceChannel || sourceChannel === channel);
  return doesApprovalRequestSelectChannelAccountFromDelivery(
    params,
    !channel || useSourceAccount ? null : await resolveApprovalRequestSessionDeliveryAsync(params),
  );
}

export { resolveLegacyApprovalRequestSessionDelivery as resolveApprovalRequestSessionDelivery };
