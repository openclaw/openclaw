// Outbound session routing maps send targets back into route/session metadata
// so outbound-only messages can be mirrored into conversation state.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { PreparedConversationRegistryScope } from "../../config/sessions/conversation-registry.js";
import {
  resolveSessionStorePathCore,
  updateSessionLastRoute,
} from "../../config/sessions/inbound.runtime.js";
import {
  loadSessionEntryReadOnly,
  loadSessionEntryReadOnlyInScope,
  updateSessionLastRouteInScope,
  type SessionAccessScope,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntryPatchGuard } from "../../config/sessions/session-entry-patch.types.js";
import { inheritSessionCreationPolicy } from "../../config/sessions/session-entry-provenance.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentRoute, type RoutePeer } from "../../routing/resolve-route.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { isGatewayExternallySupervised } from "../gateway-supervision.js";
import { buildOutboundBaseSessionKey } from "./base-session-key.js";
import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

export type OutboundSessionRoute = {
  sessionKey: string;
  baseSessionKey: string;
  /** Route authority for explicit recipient session selection. */
  recipientSessionExact?: boolean | "direct-alias" | "delivery-identity";
  peer: RoutePeer;
  chatType: "direct" | "group" | "channel";
  /** Canonical conversation identity mirrored into MsgContext.From. */
  from: string;
  /** Routable delivery address mirrored into MsgContext.To. */
  to: string;
  threadId?: string | number;
  /** Trusted human-readable target name resolved before delivery. */
  displayName?: string;
};

export type ResolveOutboundSessionRouteParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  plugin?: ChannelPlugin;
  agentId: string;
  accountId?: string | null;
  target: string;
  deliveryPurpose?: "heartbeat-owner";
  currentSessionKey?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  replyToId?: string | null;
  threadId?: string | number | null;
};

const FALLBACK_TARGET_KIND_PREFIXES: Array<{ kind: ChatType; pattern: RegExp }> = [
  { kind: "direct", pattern: /^(user:|dm:)/i },
  { kind: "channel", pattern: /^(channel:|conversation:|thread:)/i },
  { kind: "group", pattern: /^(group:|room:)/i },
];

function inferPeerKind(params: {
  channel: ChannelId;
  plugin?: ChannelPlugin;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
}): ChatType {
  const resolvedKind = params.resolvedTarget?.kind;
  if (resolvedKind === "user" || resolvedKind === "channel") {
    return resolvedKind === "user" ? "direct" : "channel";
  }
  if (resolvedKind === "group") {
    const plugin = params.plugin ?? getChannelPlugin(params.channel);
    const chatTypes = plugin?.capabilities?.chatTypes ?? [];
    return chatTypes.includes("channel") && !chatTypes.includes("group") ? "channel" : "group";
  }
  const plugin = params.plugin ?? getChannelPlugin(params.channel);
  const strippedTarget = stripTargetProviderPrefix(params.target, params.channel);
  const targets = uniqueStrings([params.target, strippedTarget].filter(Boolean));
  for (const target of targets) {
    const inferred = plugin?.messaging?.inferTargetChatType?.({ to: target });
    if (inferred === "direct" || inferred === "group" || inferred === "channel") {
      return inferred;
    }
  }
  for (const target of targets) {
    const fallback = FALLBACK_TARGET_KIND_PREFIXES.find(({ pattern }) => pattern.test(target));
    if (fallback) {
      return fallback.kind;
    }
  }
  const chatTypes = new Set(
    plugin?.capabilities?.chatTypes?.filter(
      (kind) => kind === "direct" || kind === "group" || kind === "channel",
    ),
  );
  return chatTypes.size === 1 ? (chatTypes.values().next().value ?? "direct") : "direct";
}

function resolveFallbackSession(
  params: ResolveOutboundSessionRouteParams,
): OutboundSessionRoute | null {
  const trimmed = stripTargetProviderPrefix(params.target, params.channel);
  if (!trimmed) {
    return null;
  }
  const peerKind = inferPeerKind(params);
  const peerId = stripOutboundTargetKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  const peer: RoutePeer = { kind: peerKind, id: peerId };
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer,
  });
  const from =
    peerKind === "direct"
      ? `${params.channel}:${peerId}`
      : `${params.channel}:${peerKind}:${peerId}`;
  const toPrefix = peerKind === "direct" ? "user" : "channel";
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    recipientSessionExact: false,
    peer,
    chatType: peerKind,
    from,
    to: `${toPrefix}:${peerId}`,
  };
}

function resolveOutboundSessionDisplayName(params: ResolveOutboundSessionRouteParams) {
  const resolvedTarget = params.resolvedTarget;
  const displayName = normalizeOptionalString(resolvedTarget?.display);
  if (!displayName) {
    return undefined;
  }
  if (params.channel === "imessage" && resolvedTarget?.resolutionSource === "plugin") {
    return displayName;
  }
  if (resolvedTarget?.resolutionSource !== "directory") {
    return undefined;
  }
  const target = stripTargetProviderPrefix(resolvedTarget.to, params.channel);
  const identifier = stripOutboundTargetKindPrefix(target);
  const normalizedDisplay = normalizeLowercaseStringOrEmpty(displayName);
  const identifierDisplays = uniqueStrings([resolvedTarget.to, target, identifier])
    .map(normalizeLowercaseStringOrEmpty)
    .filter(Boolean);
  return identifierDisplays.includes(normalizedDisplay) ? undefined : displayName;
}

export async function resolveOutboundSessionRoute(
  params: ResolveOutboundSessionRouteParams,
): Promise<OutboundSessionRoute | null> {
  const target = params.target.trim();
  if (!target) {
    return null;
  }
  const nextParams = { ...params, target };
  const plugin = params.plugin ?? getChannelPlugin(params.channel);
  const resolver = plugin?.messaging?.resolveOutboundSessionRoute;
  const route = resolver ? await resolver(nextParams) : resolveFallbackSession(nextParams);
  const displayName = resolveOutboundSessionDisplayName(params);
  const namedRoute = route && displayName ? { ...route, displayName } : route;
  if (!namedRoute || namedRoute.recipientSessionExact !== true) {
    return namedRoute;
  }
  const bindingRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: params.channel,
    defaultAgentId: params.agentId,
    accountId: params.accountId,
    peer: namedRoute.peer,
  });
  const isDirect = namedRoute.peer.kind === "direct";
  const globalScope = isDirect
    ? (params.cfg.session?.dmScope ?? "main")
    : (params.cfg.session?.groupScope ?? "per-group");
  const bindingScope = isDirect ? bindingRoute.dmScope : bindingRoute.groupScope;
  if (normalizeAgentId(bindingRoute.agentId) !== normalizeAgentId(params.agentId)) {
    // Another agent owns the canonical inbound session. Keep the transport
    // route, but never authorize this agent-local candidate as exact.
    return { ...namedRoute, recipientSessionExact: false };
  }
  if (bindingScope === globalScope) {
    return namedRoute;
  }
  if (
    namedRoute.sessionKey !== namedRoute.baseSessionKey &&
    !namedRoute.sessionKey.startsWith(`${namedRoute.baseSessionKey}:`)
  ) {
    return null;
  }
  return {
    ...namedRoute,
    sessionKey: `${bindingRoute.sessionKey}${namedRoute.sessionKey.slice(namedRoute.baseSessionKey.length)}`,
    baseSessionKey: bindingRoute.sessionKey,
  };
}

type OutboundSessionEntryParams = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  route: OutboundSessionRoute;
  creation?: MsgContext["SessionCreation"];
  sourceSessionKey?: string;
  /** Revalidates caller-owned route authority at the final persistence boundary. */
  assertCommitAllowed?: () => void;
  workerGuard?: SessionEntryPatchGuard;
};

type CapturedOutboundSessionBinding = {
  destination: PreparedConversationRegistryScope;
  source?: SessionAccessScope & { storePath: string };
};

type PreparedOutboundSessionBinding = Omit<CapturedOutboundSessionBinding, "source"> & {
  source?: SessionAccessScope & { databaseAgentId: string };
};

/** Capture logical locators without opening a source store that a completed retry never needs. */
export function captureOutboundSessionBinding(params: {
  cfg: OpenClawConfig;
  scope: CapturedOutboundSessionBinding["destination"];
  sourceSessionKey?: string;
}): CapturedOutboundSessionBinding {
  const destination = {
    agentId: params.scope.agentId,
    databaseAgentId: params.scope.databaseAgentId,
    storePath: params.scope.storePath,
    env: {
      OPENCLAW_STATE_DIR: resolveStateDir(params.scope.env),
      ...(isGatewayExternallySupervised(params.scope.env)
        ? { OPENCLAW_SUPERVISOR_MODE: "external" }
        : {}),
    },
  };
  if (!params.sourceSessionKey) {
    return { destination };
  }
  const source = {
    agentId: resolveAgentIdFromSessionKey(params.sourceSessionKey),
    env: destination.env,
    sessionKey: params.sourceSessionKey,
  };
  return {
    destination,
    source: {
      ...source,
      storePath: resolveSessionStorePathForScope({ ...source, env: params.scope.env }, params.cfg),
    },
  };
}

/** Resolve source ownership only when binding is needed, before asynchronous plugin routing. */
export function prepareOutboundSessionBinding(
  captured: CapturedOutboundSessionBinding,
): PreparedOutboundSessionBinding {
  const { destination, source } = captured;
  if (!source) {
    return { destination };
  }
  const target = toDatabaseOptions(resolveSqliteReadScope(source));
  return {
    destination,
    source: {
      ...source,
      databaseAgentId: target.agentId,
      storePath: resolveOpenClawAgentSqlitePath(target),
    },
  };
}

async function persistOutboundSessionEntry(
  params: OutboundSessionEntryParams,
  prepared?: PreparedOutboundSessionBinding,
): Promise<SessionEntry | null> {
  const storePath =
    prepared?.destination.storePath ??
    resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: resolveAgentIdFromSessionKey(params.route.sessionKey),
    });
  let creation = params.creation;
  if (!creation && params.sourceSessionKey) {
    const source = prepared?.source
      ? loadSessionEntryReadOnlyInScope(prepared.source)
      : loadSessionEntryReadOnly({
          sessionKey: params.sourceSessionKey,
          storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
            agentId: resolveAgentIdFromSessionKey(params.sourceSessionKey),
          }),
        });
    if (source?.sandbox === "required") {
      creation = { via: source.createdVia ?? "channel", ...inheritSessionCreationPolicy(source) };
    }
  }
  const ctx: MsgContext = {
    From: params.route.from,
    To: params.route.to,
    SessionKey: params.route.sessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.route.chatType,
    Provider: params.channel,
    Surface: params.channel,
    MessageThreadId: params.route.threadId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.route.to,
    NativeDirectUserId: params.route.peer.kind === "direct" ? params.route.peer.id : undefined,
    NativeChannelId: params.route.peer.kind === "direct" ? undefined : params.route.peer.id,
    ConversationLabel: params.route.displayName,
    GroupSubject: params.route.peer.kind === "direct" ? undefined : params.route.displayName,
    SessionCreation: creation,
  };
  // Shared-main context may still point at another channel. Commit route and
  // origin together so its conversation identity binds the exact destination.
  const update = {
    storePath,
    sessionKey: params.route.sessionKey,
    // Creation is part of this helper's contract: directory-discovered peers
    // may not have a local session row until their first outbound turn.
    createIfMissing: true,
    channel: params.channel,
    to: params.route.to,
    accountId: params.accountId ?? undefined,
    threadId: params.route.threadId,
    ctx,
    ...(params.assertCommitAllowed ? { assertCommitAllowed: params.assertCommitAllowed } : {}),
    ...(params.workerGuard ? { workerGuard: params.workerGuard } : {}),
  };
  return prepared
    ? await updateSessionLastRouteInScope(
        { ...prepared.destination, sessionKey: params.route.sessionKey },
        update,
      )
    : await updateSessionLastRoute(update);
}

/** Persists best-effort session metadata for an outbound-only route. */
export async function ensureOutboundSessionEntry(
  params: OutboundSessionEntryParams,
): Promise<void> {
  try {
    await persistOutboundSessionEntry(params);
  } catch (error) {
    if (params.creation?.sandbox === "required" || params.sourceSessionKey) {
      createSubsystemLogger("outbound/session").warn(
        `Failed to preserve outbound session creation policy for ${params.route.sessionKey}: ${String(error)}`,
      );
    }
    // Do not block outbound sends on session meta writes.
  }
}

/** Persists the route required to bind an exact conversation address to local context. */
export async function bindOutboundSessionEntry(
  params: OutboundSessionEntryParams,
  prepared?: PreparedOutboundSessionBinding,
): Promise<void> {
  const entry = await persistOutboundSessionEntry(params, prepared);
  if (!entry) {
    throw new Error(`Failed to bind outbound session ${params.route.sessionKey}`);
  }
}
