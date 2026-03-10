import crypto from "node:crypto";
import { listAgentIds } from "../../agents/agent-scope.js";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveChannelResetConfig,
  resolveExplicitAgentSessionKey,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../../config/sessions.js";
import {
  buildAgentPeerSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  toAgentRequestSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

type SessionKeyResolution = {
  sessionKey?: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

function resolveDerivedSessionKey(opts: {
  cfg: OpenClawConfig;
  to?: string;
  channel?: string;
  accountId?: string | null;
  agentId?: string;
  mainKey: string;
  scope: NonNullable<OpenClawConfig["session"]>["scope"] | "per-sender";
}): string | undefined {
  const rawTo = opts.to?.trim();
  if (!rawTo) {
    return undefined;
  }

  const agentId = normalizeAgentId(opts.agentId);
  const normalizedChannel = normalizeMessageChannel(opts.channel);
  if (normalizedChannel && isDeliverableMessageChannel(normalizedChannel)) {
    const dmScope = opts.cfg.session?.dmScope;
    return buildAgentPeerSessionKey({
      agentId,
      mainKey: opts.mainKey,
      channel: normalizedChannel,
      accountId: opts.accountId,
      peerKind: "direct",
      peerId: rawTo,
      dmScope: dmScope && dmScope !== "main" ? dmScope : "per-channel-peer",
    });
  }

  const ctx: MsgContext = { From: rawTo };
  const genericSessionKey = resolveSessionKey(opts.scope, ctx, opts.mainKey);
  const requestKey = toAgentRequestSessionKey(genericSessionKey) ?? genericSessionKey;
  return toAgentStoreSessionKey({
    agentId,
    requestKey,
    mainKey: opts.mainKey,
  });
}

export function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  accountId?: string | null;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const explicitSessionKey = opts.sessionKey?.trim();
  const fallbackAgentSessionKey = resolveExplicitAgentSessionKey({
    cfg: opts.cfg,
    agentId: opts.agentId,
  });
  const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: opts.agentId?.trim() ? normalizeAgentId(opts.agentId) : storeAgentId,
  });
  const sessionStore = loadSessionStore(storePath);

  let sessionKey: string | undefined =
    explicitSessionKey ??
    resolveDerivedSessionKey({
      cfg: opts.cfg,
      to: opts.to,
      channel: opts.channel,
      accountId: opts.accountId,
      agentId: opts.agentId,
      mainKey,
      scope,
    }) ??
    fallbackAgentSessionKey;

  // If a session id was provided, prefer to re-use its entry (by id) even when no key was derived.
  if (
    !explicitSessionKey &&
    opts.sessionId &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const foundKey = Object.keys(sessionStore).find(
      (key) => sessionStore[key]?.sessionId === opts.sessionId,
    );
    if (foundKey) {
      sessionKey = foundKey;
    }
  }

  // When sessionId was provided but not found in the primary store, search all agent stores.
  // Sessions created under a specific agent live in that agent's store file; the primary
  // store (derived from the default agent) won't contain them.
  // Also covers the case where --to derived a sessionKey that doesn't match the requested sessionId.
  if (
    opts.sessionId &&
    !explicitSessionKey &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const allAgentIds = listAgentIds(opts.cfg);
    for (const agentId of allAgentIds) {
      if (agentId === storeAgentId) {
        continue;
      }
      const altStorePath = resolveStorePath(sessionCfg?.store, { agentId });
      const altStore = loadSessionStore(altStorePath);
      const foundKey = Object.keys(altStore).find(
        (key) => altStore[key]?.sessionId === opts.sessionId,
      );
      if (foundKey) {
        return { sessionKey: foundKey, sessionStore: altStore, storePath: altStorePath };
      }
    }
  }

  return { sessionKey, sessionStore, storePath };
}

export function resolveSession(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  accountId?: string | null;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest({
    cfg: opts.cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: opts.sessionKey,
    agentId: opts.agentId,
    channel: opts.channel,
    accountId: opts.accountId,
  });
  const now = Date.now();

  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;

  const resetType = resolveSessionResetType({ sessionKey });
  const channelReset = resolveChannelResetConfig({
    sessionCfg,
    channel: sessionEntry?.lastChannel ?? sessionEntry?.channel,
  });
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg,
    resetType,
    resetOverride: channelReset,
  });
  const fresh = sessionEntry
    ? evaluateSessionFreshness({ updatedAt: sessionEntry.updatedAt, now, policy: resetPolicy })
        .fresh
    : false;
  const sessionId =
    opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !opts.sessionId;

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey,
    previousSessionId: isNewSession ? sessionEntry?.sessionId : undefined,
  });

  const persistedThinking =
    fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    fresh && sessionEntry?.verboseLevel
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  };
}
