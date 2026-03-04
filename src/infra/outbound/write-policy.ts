import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { normalizeDeliverableOutboundChannel } from "./channel-resolution.js";
import { resolveOutboundTarget } from "./targets.js";

const WILDCARD = "*";

export type RelayTarget = {
  channel: string;
  to: string;
  accountId?: string;
};

type ProtectedDestination = {
  relayTarget?: RelayTarget;
  denyReason?: string;
};

export type ProtectedDestinationMap = Map<string, ProtectedDestination>;

export type WriteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; target: RelayTarget }
  | { kind: "suppress" }
  | { kind: "deny"; reason: string };

export const SUPPRESSED_ACTIONS = new Set([
  "typing",
  "read-receipt",
  "draft-stream",
  "draft-preview",
  "status-reaction",
  "presence",
  "read",
  "loading-animation",
  "pairing",
  "access-control",
  "ack-reaction",
  "ephemeral-response",
]);

type CanonicalDestination = {
  channel: string;
  to: string;
  accountId: string;
};

type RelayRoutingRuleLike = {
  mode?: string;
  relayTo?: string;
  match?: {
    channel?: string;
    accountId?: string;
    chatId?: string;
    sender?: string;
  };
};

type RelayRoutingTargetLike = {
  channel?: string;
  to?: string;
  accountId?: string;
};

let protectedMapCache = new WeakMap<OpenClawConfig, ProtectedDestinationMap>();

function normalizeAction(action: string): string {
  return action.trim().toLowerCase();
}

function normalizeAccountComponent(
  raw: string | undefined,
  fallback: "default" | "wildcard",
): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return fallback === "wildcard" ? WILDCARD : normalizeAccountId(undefined);
  }
  if (trimmed === WILDCARD) {
    return WILDCARD;
  }
  return normalizeAccountId(trimmed);
}

function normalizeChannelComponent(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed === WILDCARD) {
    return WILDCARD;
  }
  const normalized =
    normalizeDeliverableOutboundChannel(trimmed) ?? normalizeMessageChannel(trimmed);
  return normalized ?? trimmed.toLowerCase();
}

function normalizeToComponent(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed === WILDCARD) {
    return WILDCARD;
  }
  return trimmed;
}

function buildDestinationKey(params: { channel: string; to: string; accountId: string }): string {
  return `${params.channel}|${params.to}|${params.accountId}`;
}

function canonicalizeDestination(params: {
  channel: string;
  to: string;
  accountId?: string;
  cfg?: OpenClawConfig;
}): CanonicalDestination | null {
  const channel = normalizeDeliverableOutboundChannel(params.channel);
  if (!channel) {
    return null;
  }

  const rawTo = params.to?.trim() ?? "";
  if (!rawTo || rawTo === WILDCARD) {
    return null;
  }

  const accountId = normalizeAccountComponent(params.accountId, "default");
  const resolved = resolveOutboundTarget({
    channel,
    to: rawTo,
    accountId,
    cfg: params.cfg,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return null;
  }
  return {
    channel,
    to: resolved.to,
    accountId,
  };
}

function canonicalizeRuleSource(params: { cfg: OpenClawConfig; rule: RelayRoutingRuleLike }): {
  channel: string;
  to: string;
  accountId: string;
} {
  const channel = normalizeChannelComponent(params.rule.match?.channel);
  const accountId = normalizeAccountComponent(params.rule.match?.accountId, "wildcard");
  const rawTo = normalizeToComponent(params.rule.match?.chatId);
  if (channel === WILDCARD || rawTo === WILDCARD) {
    return { channel, to: rawTo, accountId };
  }

  const canonical = canonicalizeDestination({
    cfg: params.cfg,
    channel,
    to: rawTo,
    accountId: accountId === WILDCARD ? undefined : accountId,
  });
  if (!canonical) {
    // Fail closed: if a source selector cannot be canonicalized, protect the whole channel scope.
    return { channel, to: WILDCARD, accountId };
  }
  return {
    channel: canonical.channel,
    to: canonical.to,
    accountId,
  };
}

function canonicalizeRelayTarget(params: {
  cfg: OpenClawConfig;
  target: RelayRoutingTargetLike;
}): RelayTarget | null {
  const channel = params.target.channel?.trim();
  const to = params.target.to?.trim();
  if (!channel || !to) {
    return null;
  }
  const canonical = canonicalizeDestination({
    cfg: params.cfg,
    channel,
    to,
    accountId: params.target.accountId,
  });
  if (!canonical) {
    return null;
  }
  return {
    channel: canonical.channel,
    to: canonical.to,
    accountId: canonical.accountId,
  };
}

function setFirstProtectedEntry(
  protectedMap: ProtectedDestinationMap,
  key: string,
  entry: ProtectedDestination,
): void {
  if (!protectedMap.has(key)) {
    protectedMap.set(key, entry);
  }
}

function findProtectedEntry(params: {
  protectedMap: ProtectedDestinationMap;
  destination: CanonicalDestination;
}): ProtectedDestination | undefined {
  const keys = [
    buildDestinationKey({
      channel: params.destination.channel,
      to: params.destination.to,
      accountId: params.destination.accountId,
    }),
    buildDestinationKey({
      channel: params.destination.channel,
      to: params.destination.to,
      accountId: WILDCARD,
    }),
    buildDestinationKey({
      channel: params.destination.channel,
      to: WILDCARD,
      accountId: params.destination.accountId,
    }),
    buildDestinationKey({
      channel: params.destination.channel,
      to: WILDCARD,
      accountId: WILDCARD,
    }),
    buildDestinationKey({
      channel: WILDCARD,
      to: params.destination.to,
      accountId: params.destination.accountId,
    }),
    buildDestinationKey({
      channel: WILDCARD,
      to: params.destination.to,
      accountId: WILDCARD,
    }),
    buildDestinationKey({
      channel: WILDCARD,
      to: WILDCARD,
      accountId: params.destination.accountId,
    }),
    buildDestinationKey({
      channel: WILDCARD,
      to: WILDCARD,
      accountId: WILDCARD,
    }),
  ];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const hit = params.protectedMap.get(key);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * Build a deterministic map of destinations that are subject to read-only enforcement.
 */
export function buildProtectedDestinationMap(cfg: OpenClawConfig): ProtectedDestinationMap {
  const protectedMap: ProtectedDestinationMap = new Map();
  const relayRouting = cfg.session?.relayRouting;
  if (!relayRouting) {
    return protectedMap;
  }

  const targets = relayRouting.targets ?? {};
  const rules = Array.isArray(relayRouting.rules) ? relayRouting.rules : [];

  for (const candidateRule of rules) {
    const rule = candidateRule as RelayRoutingRuleLike;
    if (rule.mode !== "read-only") {
      continue;
    }

    const source = canonicalizeRuleSource({ cfg, rule });
    const sourceKey = buildDestinationKey(source);

    const relayTo = rule.relayTo?.trim();
    const configuredTarget = relayTo
      ? (targets[relayTo] as RelayRoutingTargetLike | undefined)
      : undefined;
    const canonicalTarget = configuredTarget
      ? canonicalizeRelayTarget({ cfg, target: configuredTarget })
      : null;
    const entry: ProtectedDestination = canonicalTarget
      ? { relayTarget: canonicalTarget }
      : {
          denyReason: relayTo
            ? `Protected destination matched read-only rule but relay target "${relayTo}" is not routable.`
            : 'Protected destination matched read-only rule without "relayTo".',
        };
    setFirstProtectedEntry(protectedMap, sourceKey, entry);
  }

  if (relayRouting.defaultMode === "read-only") {
    setFirstProtectedEntry(
      protectedMap,
      buildDestinationKey({
        channel: WILDCARD,
        to: WILDCARD,
        accountId: WILDCARD,
      }),
      {
        denyReason:
          'relayRouting.defaultMode is "read-only" and no matching read-only relay target exists for this destination.',
      },
    );
  }

  return protectedMap;
}

/**
 * Return the protected destination map for the current config object identity.
 * A new config object (for example after hot-reload) always gets a freshly built map.
 */
export function getProtectedDestinationMap(cfg: OpenClawConfig): ProtectedDestinationMap {
  const cached = protectedMapCache.get(cfg);
  if (cached) {
    return cached;
  }
  const built = buildProtectedDestinationMap(cfg);
  protectedMapCache.set(cfg, built);
  return built;
}

/**
 * Test helper to reset per-config map cache between isolated test cases.
 */
export function resetProtectedDestinationMapCacheForTests(): void {
  protectedMapCache = new WeakMap<OpenClawConfig, ProtectedDestinationMap>();
}

/**
 * Decide whether an outbound write should proceed, redirect, suppress, or deny.
 */
export function decideWrite(
  action: string,
  destination: { channel: string; to: string; accountId?: string },
  protectedMap: ProtectedDestinationMap,
): WriteDecision {
  const canonical = canonicalizeDestination({
    channel: destination.channel,
    to: destination.to,
    accountId: destination.accountId,
  });
  if (!canonical) {
    return {
      kind: "deny",
      reason: `Failed to canonicalize destination (${destination.channel}:${destination.to}).`,
    };
  }

  const policy = findProtectedEntry({
    protectedMap,
    destination: canonical,
  });
  if (!policy) {
    return { kind: "allow" };
  }

  if (SUPPRESSED_ACTIONS.has(normalizeAction(action))) {
    return { kind: "suppress" };
  }

  if (policy.relayTarget) {
    return {
      kind: "redirect",
      target: policy.relayTarget,
    };
  }

  return {
    kind: "deny",
    reason: policy.denyReason ?? "Protected destination has no relay target.",
  };
}
