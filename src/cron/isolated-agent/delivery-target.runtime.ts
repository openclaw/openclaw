/** Runtime-loaded channel target helpers used by cron delivery resolution. */
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { listRouteBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import {
  resolveOutboundSessionRoute,
  type OutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import {
  resolveChannelTarget,
  type ResolvedMessagingTarget,
} from "../../infra/outbound/target-resolver.js";
import {
  normalizeRouteBindingChannelId,
  resolveNormalizedRouteBindingMatch,
} from "../../routing/binding-scope.js";
import { normalizeAccountId, normalizeAgentId } from "../../routing/session-key.js";
export { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
export { mapAllowFromEntries } from "../../plugin-sdk/channel-config-helpers.js";
export { resolveFirstBoundAccountId } from "../../routing/bound-account-read.js";

/** Resolves a cron delivery target through channel plugins with bootstrap allowed. */
export async function resolveChannelTargetForDelivery(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
}): Promise<{ ok: true; target: ResolvedMessagingTarget } | { ok: false; error: Error }> {
  // Delivery may be the first channel touch after startup; allow bootstrap so
  // plugin config and account metadata are available before target resolution.
  resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  try {
    return await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: params.input,
      accountId: params.accountId,
      unknownTargetMode: "normalized",
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/** Resolves the outbound session route used for cron delivery threading and mirrors. */
export async function resolveOutboundSessionRouteForDelivery(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: ResolvedMessagingTarget;
  threadId?: string | number | null;
  currentSessionKey?: string;
}): Promise<OutboundSessionRoute | null> {
  // Route lookup also bootstraps the plugin so canonical thread/session mapping
  // matches the send-time channel runtime.
  resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  return await resolveOutboundSessionRoute(params);
}

/** Returns whether a channel can canonicalize outbound cron delivery sessions. */
export function channelCanResolveOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
}): boolean {
  return Boolean(
    resolveOutboundChannelPlugin({
      channel: params.channel,
      cfg: params.cfg,
      allowBootstrap: true,
    })?.messaging?.resolveOutboundSessionRoute,
  );
}

/**
 * Returns the set of normalized account IDs bound to an agent.
 * When a channel is specified, only account IDs bound on that channel are
 * included; when omitted, account IDs across all channels are returned.
 * Wildcard (`*`) and channel-default (no explicit accountId) bindings are
 * not included in the returned set — use {@link hasAgentChannelDefaultBinding}
 * to check for those.
 */
export function resolveAgentBoundAccountIds(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channelId?: string;
}): Set<string> {
  const boundIds = new Set<string>();
  const normalizedAgent = normalizeAgentId(params.agentId);
  for (const binding of listRouteBindings(params.cfg)) {
    const resolved = resolveNormalizedRouteBindingMatch(binding);
    if (!resolved) {
      continue;
    }
    if (resolved.agentId !== normalizedAgent) {
      continue;
    }
    if (
      params.channelId &&
      resolved.channelId !== normalizeRouteBindingChannelId(params.channelId)
    ) {
      continue;
    }
    boundIds.add(resolved.accountId);
  }
  return boundIds;
}

/**
 * Returns whether the agent has a route binding on the given channel that
 * accepts any account ID — either via a `"*"` wildcard accountId or an
 * omitted accountId (channel-only default binding).  Channel-only bindings
 * without a concrete accountId authorize the agent to use any account on
 * that channel.
 */
export function hasAgentChannelDefaultBinding(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channelId: string;
}): boolean {
  const normalizedAgent = normalizeAgentId(params.agentId);
  const normalizedChannel = normalizeRouteBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return false;
  }
  for (const binding of listRouteBindings(params.cfg)) {
    const match = binding.match;
    if (!match || typeof match !== "object") {
      continue;
    }
    const bindingChannel = normalizeRouteBindingChannelId(match.channel);
    if (!bindingChannel || bindingChannel !== normalizedChannel) {
      continue;
    }
    if (normalizeAgentId(binding.agentId) !== normalizedAgent) {
      continue;
    }
    const accountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
    // Wildcard or omitted accountId means any account is authorized on this
    // channel for this agent.
    if (!accountId || accountId === "*") {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether an explicit accountId is authorized for an agent on a
 * channel: either by a concrete binding matching the account or by a
 * wildcard / channel-default binding.  Used by both Gateway validation and
 * runtime delivery resolution so the same authorization contract applies at
 * every layer.
 */
export function isAccountAuthorizedForAgentChannel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId: string;
  channelId: string;
}): boolean {
  const normalizedAgent = normalizeAgentId(params.agentId);
  const normalizedAccount = normalizeAccountId(params.accountId);
  const normalizedChannel = normalizeRouteBindingChannelId(params.channelId);
  if (!normalizedChannel) {
    return false;
  }
  const boundIds = resolveAgentBoundAccountIds({
    cfg: params.cfg,
    agentId: params.agentId,
    channelId: params.channelId,
  });
  if (boundIds.has(normalizedAccount)) {
    return true;
  }
  return hasAgentChannelDefaultBinding({
    cfg: params.cfg,
    agentId: params.agentId,
    channelId: params.channelId,
  });
}
