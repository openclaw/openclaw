import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeRouteBindingId, normalizeRouteBindingRoles } from "./binding-scope.js";
import { normalizeAccountId } from "./session-key.js";

export type NormalizedPeerConstraint =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "wildcard-kind"; kind: ChatType }
  | { state: "valid"; kind: ChatType; id: string };

export type NormalizedBindingMatch = {
  accountPattern: string;
  peer: NormalizedPeerConstraint;
  guildId: string | null;
  teamId: string | null;
  roles: string[] | null;
};

export type EvaluatedBinding = {
  binding: AgentRouteBinding;
  match: NormalizedBindingMatch;
  order: number;
};

type EvaluatedBindingsCache = {
  bindingsRef: OpenClawConfig["bindings"];
  byChannel: Map<string, EvaluatedBindingsByChannel>;
  byChannelAccount: Map<string, EvaluatedBindingsEntry>;
};

const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
const MAX_EVALUATED_BINDINGS_CACHE_KEYS = 2000;
type EvaluatedBindingsIndex = {
  byPeer: Map<string, EvaluatedBinding[]>;
  byPeerWildcard: EvaluatedBinding[];
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;
  byGuild: Map<string, EvaluatedBinding[]>;
  byTeam: Map<string, EvaluatedBinding[]>;
  byAccount: EvaluatedBinding[];
  byChannel: EvaluatedBinding[];
};

// Source-order candidates and their lookup index share one cache generation.
type EvaluatedBindingsEntry = {
  bindings: EvaluatedBinding[];
  index: EvaluatedBindingsIndex;
};

type EvaluatedBindingsByChannel = {
  byAccount: Map<string, EvaluatedBinding[]>;
  byAnyAccount: EvaluatedBinding[];
};

function buildEvaluatedBindingsByChannel(
  cfg: OpenClawConfig,
): Map<string, EvaluatedBindingsByChannel> {
  const byChannel = new Map<string, EvaluatedBindingsByChannel>();
  let order = 0;
  for (const binding of listRouteBindings(cfg)) {
    if (!binding || typeof binding !== "object") {
      continue;
    }
    const channel = normalizeLowercaseStringOrEmpty(binding.match?.channel);
    if (!channel) {
      continue;
    }
    const match = normalizeBindingMatch(binding.match);
    // Unmatchable peers cannot establish routing or account-ownership evidence.
    if (match.peer.state === "invalid") {
      continue;
    }
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
    pushToIndexMap(bucket.byAccount, normalizeAccountId(match.accountPattern), evaluated);
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
    const accountBinding = accountScoped[accountIdx]!;
    const anyBinding = anyAccount[anyIdx]!;
    if (accountBinding.order <= anyBinding.order) {
      merged.push(accountBinding);
      accountIdx += 1;
      continue;
    }
    merged.push(anyBinding);
    anyIdx += 1;
  }
  merged.push(...accountScoped.slice(accountIdx), ...anyAccount.slice(anyIdx));
  return merged;
}

function pushToIndexMap(
  map: Map<string, EvaluatedBinding[]>,
  key: string,
  binding: EvaluatedBinding,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(binding);
    return;
  }
  map.set(key, [binding]);
}

export function peerLookupKey(kind: ChatType, id: string): string {
  // Group/channel matching is interchangeable; share one source-ordered bucket.
  return `${kind === "channel" ? "group" : kind}:${id}`;
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
      pushToIndexMap(
        byPeer,
        peerLookupKey(binding.match.peer.kind, binding.match.peer.id),
        binding,
      );
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

export function getEvaluatedBindingsForChannelAccount(
  cfg: OpenClawConfig,
  channel: string,
  accountId: string,
): EvaluatedBindingsEntry {
  const bindingsRef = cfg.bindings;
  const existing = evaluatedBindingsCacheByCfg.get(cfg);
  const cache =
    existing && existing.bindingsRef === bindingsRef
      ? existing
      : {
          bindingsRef,
          byChannel: buildEvaluatedBindingsByChannel(cfg),
          byChannelAccount: new Map<string, EvaluatedBindingsEntry>(),
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
  const bindings = mergeEvaluatedBindingsInSourceOrder(accountScoped, anyAccount);
  const evaluated = { bindings, index: buildEvaluatedBindingsIndex(bindings) };

  cache.byChannelAccount.set(cacheKey, evaluated);
  if (cache.byChannelAccount.size > MAX_EVALUATED_BINDINGS_CACHE_KEYS) {
    cache.byChannelAccount.clear();
    cache.byChannelAccount.set(cacheKey, evaluated);
  }

  return evaluated;
}

function normalizePeerConstraint(
  peer: { kind?: string; id?: string } | undefined,
): NormalizedPeerConstraint {
  if (!peer) {
    return { state: "none" };
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeRouteBindingId(peer.id);
  if (!kind || !id) {
    return { state: "invalid" };
  }
  if (id === "*") {
    return { state: "wildcard-kind", kind };
  }
  return { state: "valid", kind, id };
}

export function normalizeBindingMatch(
  match: AgentRouteBinding["match"] | undefined,
): NormalizedBindingMatch {
  return {
    accountPattern: (match?.accountId ?? "").trim(),
    peer: normalizePeerConstraint(match?.peer),
    guildId: normalizeRouteBindingId(match?.guildId) || null,
    teamId: normalizeRouteBindingId(match?.teamId) || null,
    roles: normalizeRouteBindingRoles(match?.roles),
  };
}
