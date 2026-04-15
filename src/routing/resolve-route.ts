import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { ChatType } from "../channels/chat-type.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldLogVerbose } from "../globals.js";
import { logDebug } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { listBindings } from "./bindings.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAccountId,
  normalizeAgentId,
  sanitizeAgentId,
} from "./session-key.js";

/** @deprecated Use ChatType from channels/chat-type.js */
export type RoutePeerKind = ChatType;
export type RouteSurface = "telegram" | "tui" | "webchat" | "heartbeat" | "cron" | "hook" | "api";
export type RouteScope =
  | "agent-main"
  | "peer-scoped-direct"
  | "explicit"
  | "heartbeat-isolated"
  | "global";

export type RoutePeer = {
  kind: ChatType;
  id: string;
};

export type RouteActor = {
  provider?: string | null;
  accountId?: string | null;
  from?: string | null;
  to?: string | null;
  identityLinkKey?: string | null;
  chatType?: ChatType | null;
  label?: string | null;
};

export type ResolveSessionRouteInput = {
  cfg?: OpenClawConfig | null;
  agentId?: string | null;
  surface?: string | null;
  rawSessionInput?: string | null;
  sessionScope?: "agent" | "global";
  mainKey?: string | null;
  actor?: RouteActor | null;
  heartbeatBaseSessionKey?: string | null;
  appendHeartbeatSuffix?: boolean;
};

export type SessionRouteProvenance = {
  provider: string | null;
  accountId: string | null;
  from: string | null;
  to: string | null;
  identityLinkKey: string | null;
  chatType: ChatType | null;
  label: string | null;
  heartbeatBaseSessionKey: string | null;
  sessionScope: "agent" | "global";
  dmScope: OpenClawConfig["session"] extends { dmScope?: infer T } ? T | null : string | null;
};

export type ResolvedSessionRoute = {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
  scope: RouteScope;
  reason: string;
  explicit: boolean;
  surface: RouteSurface;
  actorFingerprint: string | null;
  provenance: SessionRouteProvenance;
  resolverVersion: typeof ROUTE_RESOLVER_VERSION;
};

export type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** Parent peer for threads — used for binding inheritance when peer doesn't match directly. */
  parentPeer?: RoutePeer | null;
  guildId?: string | null;
  teamId?: string | null;
  /** Discord member role IDs — used for role-based agent routing. */
  memberRoleIds?: string[];
};

export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  /** Internal session key used for persistence + concurrency. */
  sessionKey: string;
  /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string;
  scope: RouteScope;
  reason: string;
  explicit: boolean;
  surface: RouteSurface;
  actorFingerprint: string | null;
  provenance: SessionRouteProvenance;
  resolverVersion: typeof ROUTE_RESOLVER_VERSION;
  /** Which session should receive inbound last-route updates. */
  lastRoutePolicy: "main" | "session";
  /** Match description for debugging/logging. */
  matchedBy:
    | "binding.peer"
    | "binding.peer.parent"
    | "binding.peer.wildcard"
    | "binding.guild+roles"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
};

export { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID } from "./session-key.js";

const ROUTE_RESOLVER_VERSION = "2026-04-15-route-v1" as const;

export function deriveLastRoutePolicy(params: {
  sessionKey: string;
  mainSessionKey: string;
}): ResolvedAgentRoute["lastRoutePolicy"] {
  return params.sessionKey === params.mainSessionKey ? "main" : "session";
}

export function resolveInboundLastRouteSessionKey(params: {
  route: Pick<ResolvedAgentRoute, "lastRoutePolicy" | "mainSessionKey">;
  sessionKey: string;
}): string {
  return params.route.lastRoutePolicy === "main" ? params.route.mainSessionKey : params.sessionKey;
}

function normalizeToken(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function normalizeId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value).trim();
  }
  return "";
}

export function buildAgentSessionKey(params: {
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer?: RoutePeer | null;
  /** DM session scope. */
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  identityLinks?: Record<string, string[]>;
}): string {
  const channel = normalizeToken(params.channel) || "unknown";
  const peer = params.peer;
  return buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY,
    channel,
    accountId: params.accountId,
    peerKind: peer?.kind ?? "direct",
    peerId: peer ? normalizeId(peer.id) || "unknown" : null,
    dmScope: params.dmScope,
    identityLinks: params.identityLinks,
  });
}

function normalizeRouteSurface(value: string | undefined | null): RouteSurface {
  const normalized = normalizeToken(value);
  if (
    normalized === "telegram" ||
    normalized === "tui" ||
    normalized === "webchat" ||
    normalized === "heartbeat" ||
    normalized === "cron" ||
    normalized === "hook" ||
    normalized === "api"
  ) {
    return normalized;
  }
  return "api";
}

function normalizeRouteScopeFromSessionKey(sessionKey: string | undefined | null): RouteScope {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalized) {
    return "agent-main";
  }
  if (normalized === "global") {
    return "global";
  }
  if (normalized.endsWith(":heartbeat")) {
    return "heartbeat-isolated";
  }
  if (/:direct:/.test(normalized)) {
    return "peer-scoped-direct";
  }
  if (/^agent:[^:]+:main$/.test(normalized)) {
    return "agent-main";
  }
  if (/^agent:[^:]+:explicit:/.test(normalized)) {
    return "explicit";
  }
  return "explicit";
}

function buildRouteActorFingerprint(actor: RouteActor | null): string | null {
  if (!actor) {
    return null;
  }
  const parts = [
    actor.provider ?? "",
    actor.accountId ?? "",
    actor.chatType ?? "",
    actor.from ?? "",
    actor.to ?? "",
    actor.identityLinkKey ?? "",
  ];
  return parts.every((value) => value === "") ? null : parts.join("|");
}

function normalizeRouteActor(
  actor: RouteActor | undefined | null,
  fallbackSurface: RouteSurface,
): {
  provider: string | null;
  accountId: string;
  from: string | null;
  to: string | null;
  identityLinkKey: string | null;
  chatType: ChatType | null;
  label: string | null;
} | null {
  if (!actor || typeof actor !== "object") {
    return null;
  }
  const provider = normalizeToken(actor.provider ?? fallbackSurface);
  const accountId = normalizeAccountId(actor.accountId);
  const from = normalizeToken(actor.from);
  const to = normalizeToken(actor.to);
  const identityLinkKey = normalizeToken(actor.identityLinkKey);
  const normalizedChatType = normalizeChatType(actor.chatType ?? undefined);
  const chatType =
    normalizedChatType ??
    (normalizeToken(actor.chatType) === "direct"
      ? "direct"
      : normalizeToken(actor.chatType) === "group"
        ? "group"
        : normalizeToken(actor.chatType) === "channel"
          ? "channel"
          : null);
  const label = normalizeId(actor.label);
  if (!(provider || accountId || from || to || identityLinkKey || chatType || label)) {
    return null;
  }
  return {
    provider: provider || null,
    accountId,
    from: from || null,
    to: to || null,
    identityLinkKey: identityLinkKey || null,
    chatType,
    label: label || null,
  };
}

function resolveRoutePeerId(
  actor:
    | {
        identityLinkKey: string | null;
        from: string | null;
        to: string | null;
        label: string | null;
      }
    | null,
): string | null {
  if (!actor) {
    return null;
  }
  if (actor.identityLinkKey) {
    return actor.identityLinkKey;
  }
  if (actor.from) {
    return actor.from;
  }
  if (actor.to) {
    return actor.to;
  }
  if (actor.label) {
    return actor.label;
  }
  return null;
}

function normalizeExplicitRouteSessionKey(
  rawSessionInput: string | undefined | null,
  agentId: string,
  mainKey: string,
): string {
  const trimmed = normalizeId(rawSessionInput);
  const lowered = normalizeToken(trimmed);
  const canonicalMainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  const canonicalMainAliasKey = buildAgentMainSessionKey({
    agentId,
    mainKey: DEFAULT_MAIN_KEY,
  });
  const legacyMainSessionKey = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey,
  });
  const legacyMainAliasKey = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey: DEFAULT_MAIN_KEY,
  });
  if (!trimmed) {
    return canonicalMainSessionKey;
  }
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  if (
    lowered === "main" ||
    lowered === normalizeToken(mainKey) ||
    lowered === canonicalMainSessionKey ||
    lowered === canonicalMainAliasKey ||
    lowered === legacyMainSessionKey ||
    lowered === legacyMainAliasKey
  ) {
    return canonicalMainSessionKey;
  }
  if (lowered.startsWith("agent:")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  return `agent:${normalizeAgentId(agentId)}:${normalizeLowercaseStringOrEmpty(trimmed)}`;
}

function normalizeHeartbeatSessionKey(sessionKey: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!normalized || normalized === "global") {
    return normalized || "global";
  }
  return normalized.endsWith(":heartbeat")
    ? normalized.replace(/(:heartbeat)+$/u, ":heartbeat")
    : `${normalized}:heartbeat`;
}

function resolveHeartbeatBaseSessionKey(params: {
  agentId: string;
  mainKey: string;
  sessionScope: "agent" | "global";
  rawSessionInput?: string | null;
  heartbeatBaseSessionKey?: string | null;
}): string {
  if (params.sessionScope === "global") {
    return "global";
  }
  if (params.heartbeatBaseSessionKey?.trim()) {
    return normalizeExplicitRouteSessionKey(
      params.heartbeatBaseSessionKey,
      params.agentId,
      params.mainKey,
    );
  }
  if (params.rawSessionInput?.trim()) {
    return normalizeExplicitRouteSessionKey(params.rawSessionInput, params.agentId, params.mainKey);
  }
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
  });
}

function resolveActorSessionKey(params: {
  cfg?: OpenClawConfig | null;
  agentId: string;
  mainKey: string;
  actor: NonNullable<ReturnType<typeof normalizeRouteActor>>;
}): string {
  if (!params.actor.chatType || !params.actor.provider) {
    return buildAgentMainSessionKey({
      agentId: params.agentId,
      mainKey: params.mainKey,
    });
  }
  const peerId = resolveRoutePeerId(params.actor);
  return buildAgentPeerSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
    channel: params.actor.provider,
    accountId: params.actor.accountId ?? DEFAULT_ACCOUNT_ID,
    peerKind: params.actor.chatType,
    peerId,
    dmScope: params.cfg?.session?.dmScope,
    identityLinks: params.cfg?.session?.identityLinks,
  });
}

export function resolveSessionRoute(input: ResolveSessionRouteInput): ResolvedSessionRoute {
  const cfg = input?.cfg && typeof input.cfg === "object" ? input.cfg : undefined;
  const surface = normalizeRouteSurface(input?.surface);
  const sessionScope = input?.sessionScope === "global" ? "global" : "agent";
  const mainKey = normalizeToken(input?.mainKey) || DEFAULT_MAIN_KEY;
  const agentId = pickFirstExistingAgentId(cfg, input?.agentId);
  const actor = normalizeRouteActor(input?.actor, surface);
  const mainSessionKey =
    sessionScope === "global"
      ? "global"
      : normalizeLowercaseStringOrEmpty(
          buildAgentMainSessionKey({
            agentId,
            mainKey,
          }),
        );
  const explicitInput = normalizeId(input?.rawSessionInput);

  let sessionKey = mainSessionKey;
  let reason = `${surface}-agent-main`;
  let explicit = false;

  if (sessionScope === "global") {
    sessionKey = "global";
    reason = `${surface}-global`;
  } else if (surface === "heartbeat") {
    const baseSessionKey = resolveHeartbeatBaseSessionKey({
      agentId,
      mainKey,
      sessionScope,
      rawSessionInput: explicitInput,
      heartbeatBaseSessionKey: input?.heartbeatBaseSessionKey,
    });
    if (input?.appendHeartbeatSuffix === false) {
      sessionKey = baseSessionKey;
      explicit = Boolean(explicitInput || input?.heartbeatBaseSessionKey);
      reason = input?.heartbeatBaseSessionKey?.trim()
        ? "heartbeat-base-session"
        : explicitInput
          ? "heartbeat-explicit-base"
          : "heartbeat-agent-main-base";
    } else {
      sessionKey = normalizeHeartbeatSessionKey(baseSessionKey);
      explicit = Boolean(explicitInput || input?.heartbeatBaseSessionKey);
      reason = input?.heartbeatBaseSessionKey?.trim()
        ? "heartbeat-isolated-base-session"
        : explicitInput
          ? "heartbeat-isolated-explicit"
          : "heartbeat-isolated-agent-main";
    }
  } else if (explicitInput) {
    sessionKey = normalizeExplicitRouteSessionKey(explicitInput, agentId, mainKey);
    explicit = true;
    reason = `${surface}-explicit-session`;
  } else if (actor?.provider && actor.chatType) {
    sessionKey = normalizeLowercaseStringOrEmpty(
      resolveActorSessionKey({
        cfg,
        agentId,
        mainKey,
        actor,
      }),
    );
    reason = actor.chatType === "direct" ? `${surface}-peer-direct` : `${surface}-peer`;
  }

  const scope = normalizeRouteScopeFromSessionKey(sessionKey);
  return {
    agentId,
    sessionKey,
    mainSessionKey,
    scope,
    reason,
    explicit,
    surface,
    actorFingerprint: buildRouteActorFingerprint(actor),
    provenance: {
      provider: actor?.provider ?? null,
      accountId: actor?.accountId ?? null,
      from: actor?.from ?? null,
      to: actor?.to ?? null,
      identityLinkKey: actor?.identityLinkKey ?? null,
      chatType: actor?.chatType ?? null,
      label: actor?.label ?? null,
      heartbeatBaseSessionKey: input?.heartbeatBaseSessionKey?.trim() || null,
      sessionScope,
      dmScope: cfg?.session?.dmScope ?? null,
    },
    resolverVersion: ROUTE_RESOLVER_VERSION,
  };
}

function listAgents(cfg: OpenClawConfig) {
  const agents = cfg.agents?.list;
  return Array.isArray(agents) ? agents : [];
}

type AgentLookupCache = {
  agentsRef: OpenClawConfig["agents"] | undefined;
  byNormalizedId: Map<string, string>;
  fallbackDefaultAgentId: string;
};

const agentLookupCacheByCfg = new WeakMap<OpenClawConfig, AgentLookupCache>();

function resolveAgentLookupCache(cfg: OpenClawConfig): AgentLookupCache {
  const agentsRef = cfg.agents;
  const existing = agentLookupCacheByCfg.get(cfg);
  if (existing && existing.agentsRef === agentsRef) {
    return existing;
  }

  const byNormalizedId = new Map<string, string>();
  for (const agent of listAgents(cfg)) {
    const rawId = agent.id?.trim();
    if (!rawId) {
      continue;
    }
    byNormalizedId.set(normalizeAgentId(rawId), sanitizeAgentId(rawId));
  }
  const next: AgentLookupCache = {
    agentsRef,
    byNormalizedId,
    fallbackDefaultAgentId: sanitizeAgentId(resolveDefaultAgentId(cfg)),
  };
  agentLookupCacheByCfg.set(cfg, next);
  return next;
}

export function pickFirstExistingAgentId(
  cfg: OpenClawConfig | null | undefined,
  agentId: string | undefined | null,
): string {
  if (!cfg || typeof cfg !== "object") {
    const trimmed = (agentId ?? "").trim();
    return trimmed ? sanitizeAgentId(trimmed) : "main";
  }
  const lookup = resolveAgentLookupCache(cfg);
  const trimmed = (agentId ?? "").trim();
  if (!trimmed) {
    return lookup.fallbackDefaultAgentId;
  }
  const normalized = normalizeAgentId(trimmed);
  if (lookup.byNormalizedId.size === 0) {
    return sanitizeAgentId(trimmed);
  }
  const resolved = lookup.byNormalizedId.get(normalized);
  if (resolved) {
    return resolved;
  }
  return lookup.fallbackDefaultAgentId;
}

type NormalizedPeerConstraint =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "wildcard-kind"; kind: ChatType }
  | { state: "valid"; kind: ChatType; id: string };

type NormalizedBindingMatch = {
  accountPattern: string;
  peer: NormalizedPeerConstraint;
  guildId: string | null;
  teamId: string | null;
  roles: string[] | null;
};

type EvaluatedBinding = {
  binding: ReturnType<typeof listBindings>[number];
  match: NormalizedBindingMatch;
  order: number;
};

type BindingScope = {
  peer: RoutePeer | null;
  guildId: string;
  teamId: string;
  memberRoleIds: Set<string>;
};

type EvaluatedBindingsCache = {
  bindingsRef: OpenClawConfig["bindings"];
  byChannel: Map<string, EvaluatedBindingsByChannel>;
  byChannelAccount: Map<string, EvaluatedBinding[]>;
  byChannelAccountIndex: Map<string, EvaluatedBindingsIndex>;
};

const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2000;
const resolvedRouteCacheByCfg = new WeakMap<
  OpenClawConfig,
  {
    bindingsRef: OpenClawConfig["bindings"];
    agentsRef: OpenClawConfig["agents"];
    sessionRef: OpenClawConfig["session"];
    byKey: Map<string, ResolvedAgentRoute>;
  }
>();
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;

type EvaluatedBindingsIndex = {
  byPeer: Map<string, EvaluatedBinding[]>;
  byPeerWildcard: EvaluatedBinding[];
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;
  byGuild: Map<string, EvaluatedBinding[]>;
  byTeam: Map<string, EvaluatedBinding[]>;
  byAccount: EvaluatedBinding[];
  byChannel: EvaluatedBinding[];
};

type EvaluatedBindingsByChannel = {
  byAccount: Map<string, EvaluatedBinding[]>;
  byAnyAccount: EvaluatedBinding[];
};

function resolveAccountPatternKey(accountPattern: string): string {
  if (!accountPattern.trim()) {
    return DEFAULT_ACCOUNT_ID;
  }
  return normalizeAccountId(accountPattern);
}

function buildEvaluatedBindingsByChannel(
  cfg: OpenClawConfig,
): Map<string, EvaluatedBindingsByChannel> {
  const byChannel = new Map<string, EvaluatedBindingsByChannel>();
  let order = 0;
  for (const binding of listBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const channel = normalizeToken(binding.match?.channel);
    if (!channel) {
      continue;
    }
    const match = normalizeBindingMatch(binding.match);
    const evaluated: EvaluatedBinding = {
      binding,
      match,
      order,
    };
    order += 1;
    let bucket = byChannel.get(channel);
    if (!bucket) {
      bucket = {
        byAccount: new Map<string, EvaluatedBinding[]>(),
        byAnyAccount: [],
      };
      byChannel.set(channel, bucket);
    }
    if (match.accountPattern === "*") {
      bucket.byAnyAccount.push(evaluated);
      continue;
    }
    const accountKey = resolveAccountPatternKey(match.accountPattern);
    const existing = bucket.byAccount.get(accountKey);
    if (existing) {
      existing.push(evaluated);
      continue;
    }
    bucket.byAccount.set(accountKey, [evaluated]);
  }
  return byChannel;
}

function mergeEvaluatedBindingsInSourceOrder(
  accountScoped: EvaluatedBinding[],
  anyAccount: EvaluatedBinding[],
): EvaluatedBinding[] {
  if (accountScoped.length === 0) {
    return anyAccount;
  }
  if (anyAccount.length === 0) {
    return accountScoped;
  }
  const merged: EvaluatedBinding[] = [];
  let accountIdx = 0;
  let anyIdx = 0;
  while (accountIdx < accountScoped.length && anyIdx < anyAccount.length) {
    const accountBinding = accountScoped[accountIdx];
    const anyBinding = anyAccount[anyIdx];
    if (
      (accountBinding?.order ?? Number.MAX_SAFE_INTEGER) <=
      (anyBinding?.order ?? Number.MAX_SAFE_INTEGER)
    ) {
      if (accountBinding) {
        merged.push(accountBinding);
      }
      accountIdx += 1;
      continue;
    }
    if (anyBinding) {
      merged.push(anyBinding);
    }
    anyIdx += 1;
  }
  if (accountIdx < accountScoped.length) {
    merged.push(...accountScoped.slice(accountIdx));
  }
  if (anyIdx < anyAccount.length) {
    merged.push(...anyAccount.slice(anyIdx));
  }
  return merged;
}

function pushToIndexMap(
  map: Map<string, EvaluatedBinding[]>,
  key: string | null,
  binding: EvaluatedBinding,
): void {
  if (!key) {
    return;
  }
  const existing = map.get(key);
  if (existing) {
    existing.push(binding);
    return;
  }
  map.set(key, [binding]);
}

function peerLookupKeys(kind: ChatType, id: string): string[] {
  if (kind === "group") {
    return [`group:${id}`, `channel:${id}`];
  }
  if (kind === "channel") {
    return [`channel:${id}`, `group:${id}`];
  }
  return [`${kind}:${id}`];
}

function collectPeerIndexedBindings(
  index: EvaluatedBindingsIndex,
  peer: RoutePeer | null,
): EvaluatedBinding[] {
  if (!peer) {
    return [];
  }
  const out: EvaluatedBinding[] = [];
  const seen = new Set<EvaluatedBinding>();
  for (const key of peerLookupKeys(peer.kind, peer.id)) {
    const matches = index.byPeer.get(key);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      if (seen.has(match)) {
        continue;
      }
      seen.add(match);
      out.push(match);
    }
  }
  return out;
}

function buildEvaluatedBindingsIndex(bindings: EvaluatedBinding[]): EvaluatedBindingsIndex {
  const byPeer = new Map<string, EvaluatedBinding[]>();
  const byPeerWildcard: EvaluatedBinding[] = [];
  const byGuildWithRoles = new Map<string, EvaluatedBinding[]>();
  const byGuild = new Map<string, EvaluatedBinding[]>();
  const byTeam = new Map<string, EvaluatedBinding[]>();
  const byAccount: EvaluatedBinding[] = [];
  const byChannel: EvaluatedBinding[] = [];

  for (const binding of bindings) {
    if (binding.match.peer.state === "valid") {
      for (const key of peerLookupKeys(binding.match.peer.kind, binding.match.peer.id)) {
        pushToIndexMap(byPeer, key, binding);
      }
      continue;
    }
    if (binding.match.peer.state === "wildcard-kind") {
      byPeerWildcard.push(binding);
      continue;
    }
    if (binding.match.guildId && binding.match.roles) {
      pushToIndexMap(byGuildWithRoles, binding.match.guildId, binding);
      continue;
    }
    if (binding.match.guildId && !binding.match.roles) {
      pushToIndexMap(byGuild, binding.match.guildId, binding);
      continue;
    }
    if (binding.match.teamId) {
      pushToIndexMap(byTeam, binding.match.teamId, binding);
      continue;
    }
    if (binding.match.accountPattern !== "*") {
      byAccount.push(binding);
      continue;
    }
    byChannel.push(binding);
  }

  return {
    byPeer,
    byPeerWildcard,
    byGuildWithRoles,
    byGuild,
    byTeam,
    byAccount,
    byChannel,
  };
}

function getEvaluatedBindingsForChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): EvaluatedBinding[] {
  const bindingsRef = cfg.bindings;
  const existing = evaluatedBindingsCacheByCfg.get(cfg);
  const cache =
    existing && existing.bindingsRef === bindingsRef
      ? existing
      : {
          bindingsRef,
          byChannel: buildEvaluatedBindingsByChannel(cfg),
          byChannelAccount: new Map<string, EvaluatedBinding[]>(),
          byChannelAccountIndex: new Map<string, EvaluatedBindingsIndex>(),
        };
  if (cache !== existing) {
    evaluatedBindingsCacheByCfg.set(cfg, cache);
  }

  const cacheKey = `${channel}\t${accountId}`;
  const hit = cache.byChannelAccount.get(cacheKey);
  if (hit) {
    return hit;
  }

  const channelBindings = cache.byChannel.get(channel);
  const accountScoped = channelBindings?.byAccount.get(accountId) ?? [];
  const anyAccount = channelBindings?.byAnyAccount ?? [];
  const evaluated = mergeEvaluatedBindingsInSourceOrder(accountScoped, anyAccount);

  cache.byChannelAccount.set(cacheKey, evaluated);
  cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
  if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
    cache.byChannelAccount.clear();
    cache.byChannelAccountIndex.clear();
    cache.byChannelAccount.set(cacheKey, evaluated);
    cache.byChannelAccountIndex.set(cacheKey, buildEvaluatedBindingsIndex(evaluated));
  }

  return evaluated;
}

function getEvaluatedBindingIndexForChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): EvaluatedBindingsIndex {
  const bindings = getEvaluatedBindingsForChannelAccount(cfg, channel, accountId);
  const existing = evaluatedBindingsCacheByCfg.get(cfg);
  const cacheKey = `${channel}\t${accountId}`;
  const indexed = existing?.byChannelAccountIndex.get(cacheKey);
  if (indexed) {
    return indexed;
  }
  const built = buildEvaluatedBindingsIndex(bindings);
  existing?.byChannelAccountIndex.set(cacheKey, built);
  return built;
}

function normalizePeerConstraint(
  peer: { kind?: string; id?: string } | undefined,
): NormalizedPeerConstraint {
  if (!peer) {
    return { state: "none" };
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeId(peer.id);
  if (!kind || !id) {
    return { state: "invalid" };
  }
  if (id === "*") {
    return { state: "wildcard-kind", kind };
  }
  return { state: "valid", kind, id };
}

function normalizeBindingMatch(
  match:
    | {
        accountId?: string | undefined;
        peer?: { kind?: string; id?: string } | undefined;
        guildId?: string | undefined;
        teamId?: string | undefined;
        roles?: string[] | undefined;
      }
    | undefined,
): NormalizedBindingMatch {
  const rawRoles = match?.roles;
  return {
    accountPattern: (match?.accountId ?? "").trim(),
    peer: normalizePeerConstraint(match?.peer),
    guildId: normalizeId(match?.guildId) || null,
    teamId: normalizeId(match?.teamId) || null,
    roles: Array.isArray(rawRoles) && rawRoles.length > 0 ? rawRoles : null,
  };
}

function resolveRouteCacheForConfig(cfg: OpenClawConfig): Map<string, ResolvedAgentRoute> {
  const existing = resolvedRouteCacheByCfg.get(cfg);
  if (
    existing &&
    existing.bindingsRef === cfg.bindings &&
    existing.agentsRef === cfg.agents &&
    existing.sessionRef === cfg.session
  ) {
    return existing.byKey;
  }
  const byKey = new Map<string, ResolvedAgentRoute>();
  resolvedRouteCacheByCfg.set(cfg, {
    bindingsRef: cfg.bindings,
    agentsRef: cfg.agents,
    sessionRef: cfg.session,
    byKey,
  });
  return byKey;
}

function formatRouteCachePeer(peer: RoutePeer | null): string {
  if (!peer || !peer.id) {
    return "-";
  }
  return `${peer.kind}:${peer.id}`;
}

function formatRoleIdsCacheKey(roleIds: string[]): string {
  const count = roleIds.length;
  if (count === 0) {
    return "-";
  }
  if (count === 1) {
    return roleIds[0] ?? "-";
  }
  if (count === 2) {
    const first = roleIds[0] ?? "";
    const second = roleIds[1] ?? "";
    return first <= second ? `${first},${second}` : `${second},${first}`;
  }
  return roleIds.toSorted().join(",");
}

function buildResolvedRouteCacheKey(params: {
  channel: string;
  accountId: string;
  peer: RoutePeer | null;
  parentPeer: RoutePeer | null;
  guildId: string;
  teamId: string;
  memberRoleIds: string[];
  dmScope: string;
}): string {
  return `${params.channel}\t${params.accountId}\t${formatRouteCachePeer(params.peer)}\t${formatRouteCachePeer(params.parentPeer)}\t${params.guildId || "-"}\t${params.teamId || "-"}\t${formatRoleIdsCacheKey(params.memberRoleIds)}\t${params.dmScope}`;
}

function hasGuildConstraint(match: NormalizedBindingMatch): boolean {
  return Boolean(match.guildId);
}

function hasTeamConstraint(match: NormalizedBindingMatch): boolean {
  return Boolean(match.teamId);
}

function hasRolesConstraint(match: NormalizedBindingMatch): boolean {
  return Boolean(match.roles);
}

function peerKindMatches(bindingKind: ChatType, scopeKind: ChatType): boolean {
  if (bindingKind === scopeKind) {
    return true;
  }
  const both = new Set([bindingKind, scopeKind]);
  return both.has("group") && both.has("channel");
}

function matchesBindingScope(match: NormalizedBindingMatch, scope: BindingScope): boolean {
  if (match.peer.state === "invalid") {
    return false;
  }
  if (match.peer.state === "valid") {
    if (
      !scope.peer ||
      !peerKindMatches(match.peer.kind, scope.peer.kind) ||
      scope.peer.id !== match.peer.id
    ) {
      return false;
    }
  }
  if (match.peer.state === "wildcard-kind") {
    if (!scope.peer || !peerKindMatches(match.peer.kind, scope.peer.kind)) {
      return false;
    }
  }
  if (match.guildId && match.guildId !== scope.guildId) {
    return false;
  }
  if (match.teamId && match.teamId !== scope.teamId) {
    return false;
  }
  if (match.roles) {
    for (const role of match.roles) {
      if (scope.memberRoleIds.has(role)) {
        return true;
      }
    }
    return false;
  }
  return true;
}

export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  const channel = normalizeToken(input.channel);
  const accountId = normalizeAccountId(input.accountId);
  const peer = input.peer
    ? {
        kind: normalizeChatType(input.peer.kind) ?? input.peer.kind,
        id: normalizeId(input.peer.id),
      }
    : null;
  const guildId = normalizeId(input.guildId);
  const teamId = normalizeId(input.teamId);
  const memberRoleIds = input.memberRoleIds ?? [];
  const memberRoleIdSet = new Set(memberRoleIds);
  const dmScope = input.cfg.session?.dmScope ?? "main";
  const identityLinks = input.cfg.session?.identityLinks;
  const shouldLogDebug = shouldLogVerbose();
  const parentPeer = input.parentPeer
    ? {
        kind: normalizeChatType(input.parentPeer.kind) ?? input.parentPeer.kind,
        id: normalizeId(input.parentPeer.id),
      }
    : null;

  const routeCache =
    !shouldLogDebug && !identityLinks ? resolveRouteCacheForConfig(input.cfg) : null;
  const routeCacheKey = routeCache
    ? buildResolvedRouteCacheKey({
        channel,
        accountId,
        peer,
        parentPeer,
        guildId,
        teamId,
        memberRoleIds,
        dmScope,
      })
    : "";
  if (routeCache && routeCacheKey) {
    const cachedRoute = routeCache.get(routeCacheKey);
    if (cachedRoute) {
      return { ...cachedRoute };
    }
  }

  const bindings = getEvaluatedBindingsForChannelAccount(input.cfg, channel, accountId);
  const bindingsIndex = getEvaluatedBindingIndexForChannelAccount(input.cfg, channel, accountId);

  const choose = (agentId: string, matchedBy: ResolvedAgentRoute["matchedBy"]) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    const resolved = resolveSessionRoute({
      cfg: input.cfg,
      agentId: resolvedAgentId,
      surface: channel || "api",
      sessionScope: "agent",
      actor: peer
        ? {
            provider: channel,
            accountId,
            from: normalizeId(peer.id),
            to: normalizeId(peer.id),
            chatType: peer.kind,
          }
        : {
            provider: channel,
            accountId,
          },
    });
    const sessionKey = resolved.sessionKey;
    const mainSessionKey = resolved.mainSessionKey;
    const route = {
      agentId: resolvedAgentId,
      channel,
      accountId,
      sessionKey,
      mainSessionKey,
      scope: resolved.scope,
      reason: resolved.reason,
      explicit: resolved.explicit,
      surface: resolved.surface,
      actorFingerprint: resolved.actorFingerprint,
      provenance: resolved.provenance,
      resolverVersion: resolved.resolverVersion,
      lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
      matchedBy,
    };
    if (routeCache && routeCacheKey) {
      routeCache.set(routeCacheKey, route);
      if (routeCache.size > MAX_RESOLVED_ROUTE_CACHE_KEYS) {
        routeCache.clear();
        routeCache.set(routeCacheKey, route);
      }
    }
    return route;
  };

  const formatPeer = (value?: RoutePeer | null) =>
    value?.kind && value?.id ? `${value.kind}:${value.id}` : "none";
  const formatNormalizedPeer = (value: NormalizedPeerConstraint) => {
    if (value.state === "none") {
      return "none";
    }
    if (value.state === "invalid") {
      return "invalid";
    }
    if (value.state === "wildcard-kind") {
      return `${value.kind}:*`;
    }
    return `${value.kind}:${value.id}`;
  };

  if (shouldLogDebug) {
    logDebug(
      `[routing] resolveAgentRoute: channel=${channel} accountId=${accountId} peer=${formatPeer(peer)} guildId=${guildId || "none"} teamId=${teamId || "none"} bindings=${bindings.length}`,
    );
    for (const entry of bindings) {
      logDebug(
        `[routing] binding: agentId=${entry.binding.agentId} accountPattern=${entry.match.accountPattern || "default"} peer=${formatNormalizedPeer(entry.match.peer)} guildId=${entry.match.guildId ?? "none"} teamId=${entry.match.teamId ?? "none"} roles=${entry.match.roles?.length ?? 0}`,
      );
    }
  }
  // Thread parent inheritance: if peer (thread) didn't match, check parent peer binding
  const baseScope = {
    guildId,
    teamId,
    memberRoleIds: memberRoleIdSet,
  };

  const tiers: Array<{
    matchedBy: Exclude<ResolvedAgentRoute["matchedBy"], "default">;
    enabled: boolean;
    scopePeer: RoutePeer | null;
    candidates: EvaluatedBinding[];
    predicate: (candidate: EvaluatedBinding) => boolean;
  }> = [
    {
      matchedBy: "binding.peer",
      enabled: Boolean(peer),
      scopePeer: peer,
      candidates: collectPeerIndexedBindings(bindingsIndex, peer),
      predicate: (candidate) => candidate.match.peer.state === "valid",
    },
    {
      matchedBy: "binding.peer.parent",
      enabled: Boolean(parentPeer && parentPeer.id),
      scopePeer: parentPeer && parentPeer.id ? parentPeer : null,
      candidates: collectPeerIndexedBindings(bindingsIndex, parentPeer),
      predicate: (candidate) => candidate.match.peer.state === "valid",
    },
    {
      matchedBy: "binding.peer.wildcard",
      enabled: Boolean(peer),
      scopePeer: peer,
      candidates: bindingsIndex.byPeerWildcard,
      predicate: (candidate) => candidate.match.peer.state === "wildcard-kind",
    },
    {
      matchedBy: "binding.guild+roles",
      enabled: Boolean(guildId && memberRoleIds.length > 0),
      scopePeer: peer,
      candidates: guildId ? (bindingsIndex.byGuildWithRoles.get(guildId) ?? []) : [],
      predicate: (candidate) =>
        hasGuildConstraint(candidate.match) && hasRolesConstraint(candidate.match),
    },
    {
      matchedBy: "binding.guild",
      enabled: Boolean(guildId),
      scopePeer: peer,
      candidates: guildId ? (bindingsIndex.byGuild.get(guildId) ?? []) : [],
      predicate: (candidate) =>
        hasGuildConstraint(candidate.match) && !hasRolesConstraint(candidate.match),
    },
    {
      matchedBy: "binding.team",
      enabled: Boolean(teamId),
      scopePeer: peer,
      candidates: teamId ? (bindingsIndex.byTeam.get(teamId) ?? []) : [],
      predicate: (candidate) => hasTeamConstraint(candidate.match),
    },
    {
      matchedBy: "binding.account",
      enabled: true,
      scopePeer: peer,
      candidates: bindingsIndex.byAccount,
      predicate: (candidate) => candidate.match.accountPattern !== "*",
    },
    {
      matchedBy: "binding.channel",
      enabled: true,
      scopePeer: peer,
      candidates: bindingsIndex.byChannel,
      predicate: (candidate) => candidate.match.accountPattern === "*",
    },
  ];

  for (const tier of tiers) {
    if (!tier.enabled) {
      continue;
    }
    const matched = tier.candidates.find(
      (candidate) =>
        tier.predicate(candidate) &&
        matchesBindingScope(candidate.match, {
          ...baseScope,
          peer: tier.scopePeer,
        }),
    );
    if (matched) {
      if (shouldLogDebug) {
        logDebug(`[routing] match: matchedBy=${tier.matchedBy} agentId=${matched.binding.agentId}`);
      }
      return choose(matched.binding.agentId, tier.matchedBy);
    }
  }

  return choose(resolveDefaultAgentId(input.cfg), "default");
}
