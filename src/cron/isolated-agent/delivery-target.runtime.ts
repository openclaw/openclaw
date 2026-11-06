/** Runtime-loaded channel target helpers used by cron delivery resolution. */
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
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
import { DEFAULT_ACCOUNT_ID } from "../../routing/account-id.js";
export { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
export { mapAllowFromEntries } from "../../plugin-sdk/channel-config-helpers.js";
export { resolveFirstBoundAccountId } from "../../routing/bound-account-read.js";
export { resolveProactiveDeliveryTargetWithSessionRoute } from "../../infra/outbound/targets.js";

/** Picks the channel's own default account for a delivery that names none and has no binding. */
export function resolveChannelDefaultAccountIdForDelivery(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
}): string | undefined {
  const plugin = resolveOutboundChannelPlugin({ ...params, allowBootstrap: true });
  const accountId = plugin
    ? resolveChannelDefaultAccountId({ plugin, cfg: params.cfg })
    : undefined;
  // Keep an unnamed default implicit; only a configured account changes the route.
  return accountId === DEFAULT_ACCOUNT_ID ? undefined : accountId;
}

/** Resolves a cron delivery target through channel plugins with bootstrap allowed. */
export async function resolveChannelTargetForDelivery(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
  input: string;
  accountId?: string | null;
}): Promise<{ ok: true; target: ResolvedMessagingTarget } | { ok: false; error: Error }> {
  // Delivery may be the first channel touch after startup; allow bootstrap so
  // plugin config and account metadata are available before target resolution.
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  try {
    return await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: params.input,
      accountId: params.accountId,
      unknownTargetMode: "normalized",
      plugin,
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
  const plugin = resolveOutboundChannelPlugin({
    channel: params.channel,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  return await resolveOutboundSessionRoute({ ...params, plugin });
}

/** Returns whether a channel can canonicalize outbound cron delivery sessions. */
export function channelCanResolveOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  agentId: string;
}): boolean {
  return Boolean(
    resolveOutboundChannelPlugin({
      channel: params.channel,
      cfg: params.cfg,
      agentId: params.agentId,
      allowBootstrap: true,
    })?.messaging?.resolveOutboundSessionRoute,
  );
}
