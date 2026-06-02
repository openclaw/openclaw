import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { resolveMaintenanceConfigFromInput } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequestLike = ExecApprovalRequest | PluginApprovalRequest;

/** Channel/account binding recovered from a persisted session store entry. */
type ApprovalRequestSessionBinding = {
  channel?: string;
  accountId?: string;
};

/** Persisted session entry paired with the exact approval request session key. */
type PersistedApprovalRequestSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

function normalizeOptionalChannel(value?: string | null): string | undefined {
  return normalizeMessageChannel(value);
}

/** Load the persisted session entry addressed by an approval request's session key. */
export function resolvePersistedApprovalRequestSessionEntry(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): PersistedApprovalRequestSessionEntry | null {
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  // Placeholder store paths need the session-key agent first; older approval payloads may only
  // carry request.agentId, so keep that as the fallback before defaulting to main.
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath, {
    maintenanceConfig: resolveMaintenanceConfigFromInput(params.cfg.session?.maintenance),
  });
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }
  return { sessionKey, entry };
}

function resolvePersistedApprovalRequestSessionBinding(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
}): ApprovalRequestSessionBinding | null {
  const persisted = resolvePersistedApprovalRequestSessionEntry(params);
  if (!persisted) {
    return null;
  }
  const { entry } = persisted;
  const channel = normalizeOptionalChannel(entry.origin?.provider ?? entry.lastChannel);
  const accountId = normalizeOptionalAccountId(entry.origin?.accountId ?? entry.lastAccountId);
  return channel || accountId ? { channel, accountId } : null;
}

/**
 * Resolve the freshest account id that owns an approval request.
 *
 * Turn-source account metadata wins when its channel matches the requested channel; otherwise
 * callers may fall back to the persisted session binding from the approval's session key.
 */
export function resolveApprovalRequestAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel?: string | null;
}): string | null {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (expectedChannel && turnSourceChannel && turnSourceChannel !== expectedChannel) {
    // Turn-source metadata is the freshest signal; never borrow a session account across channels.
    return null;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  if (turnSourceAccountId) {
    return turnSourceAccountId;
  }

  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  const sessionChannel = sessionBinding?.channel;
  if (expectedChannel && sessionChannel && sessionChannel !== expectedChannel) {
    return null;
  }

  return sessionBinding?.accountId ?? null;
}

/**
 * Resolve the account id for one concrete approval channel.
 *
 * This variant can recover a session-bound account even when the live turn source came from a
 * different channel, which lets explicit channel routes verify their own persisted binding.
 */
export function resolveApprovalRequestChannelAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
}): string | null {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (!expectedChannel) {
    return null;
  }
  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (!turnSourceChannel || turnSourceChannel === expectedChannel) {
    return resolveApprovalRequestAccountId(params);
  }

  // If the live turn came from another channel, only a persisted binding for the requested
  // channel can prove this account relationship.
  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  return sessionBinding?.channel === expectedChannel ? (sessionBinding.accountId ?? null) : null;
}

/**
 * Check whether an approval request is eligible for a channel/account-specific route.
 *
 * Explicit turn-source accounts are authoritative; persisted accounts only narrow the match when
 * no fresher account metadata is present.
 */
export function doesApprovalRequestMatchChannelAccount(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequestLike;
  channel: string;
  accountId?: string | null;
}): boolean {
  const expectedChannel = normalizeOptionalChannel(params.channel);
  if (!expectedChannel) {
    return false;
  }

  const turnSourceChannel = normalizeOptionalChannel(params.request.request.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== expectedChannel) {
    return false;
  }

  const turnSourceAccountId = normalizeOptionalAccountId(
    params.request.request.turnSourceAccountId,
  );
  const expectedAccountId = normalizeOptionalAccountId(params.accountId);
  if (turnSourceAccountId) {
    // Explicit turn-source account ids are authoritative; they should not be broadened by stale
    // session-store account data.
    return !expectedAccountId || expectedAccountId === turnSourceAccountId;
  }

  const sessionBinding = resolvePersistedApprovalRequestSessionBinding(params);
  const sessionChannel = sessionBinding?.channel;
  if (sessionChannel && sessionChannel !== expectedChannel) {
    return false;
  }

  const boundAccountId = sessionBinding?.accountId;
  return !expectedAccountId || !boundAccountId || expectedAccountId === boundAccountId;
}
