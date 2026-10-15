import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { resolveChannelAllowFrom } from "../../channels/account-resolution.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { isSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import {
  resolveTargetPrefixedChannel,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import { isPotentialConfiguredMessageChannel } from "./message-account-selection.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";
import { listRuntimeVisibleChannelPlugins } from "./runtime-visible-channels.js";
import { isReservedTargetLiteralError } from "./target-errors.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import {
  resolveOutboundTargetWithPlugin,
  type OutboundTargetResolution,
  type ResolveOutboundTargetParams,
} from "./targets-resolve-shared.js";
import { resolveSessionDeliveryTarget } from "./targets-session.js";

/** Resolved outbound delivery destination and routing hints. */
type OutboundTarget = {
  channel: string;
  to?: string;
  targetSessionKey?: string;
  chatType?: ChatType;
  reason?: string;
  accountId?: string;
  threadId?: string | number;
  lastChannel?: string;
  lastAccountId?: string;
  implicitDefaultRoute?: true;
};

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";

/** Resolves a user-supplied outbound destination through the channel plugin. */
export async function resolveOutboundTarget(
  params: ResolveOutboundTargetParams & { plugin?: ChannelPlugin; allowBootstrap?: boolean },
): Promise<OutboundTargetResolution> {
  return (
    (await resolveOutboundTargetWithPlugin({
      plugin:
        params.plugin ??
        resolveOutboundChannelPlugin({
          channel: params.channel,
          cfg: params.cfg,
          allowBootstrap: params.allowBootstrap,
        }),
      target: params,
    })) ?? {
      ok: false,
      error: new Error(`Unsupported channel: ${params.channel}`),
    }
  );
}

function concreteAllowFromEntries(entries: Array<string | number> | null | undefined): string[] {
  return mapAllowFromEntries(entries)
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== "*" && !entry.endsWith(":*"));
}

function ownerIdMatchesRoute(plugin: ChannelPlugin, ownerId: string, routeTo: string): boolean {
  const normalize = (value: string) => {
    const prefixedChannel = resolveTargetPrefixedChannel(value);
    return prefixedChannel === plugin.id
      ? stripTargetProviderPrefix(value, plugin.id, ...(plugin.messaging?.targetPrefixes ?? []))
      : value.trim();
  };
  return normalize(ownerId) === normalize(routeTo);
}

/** Per-send proactive delivery policy; never reads scheduler configuration. */
export type ProactiveDeliveryPolicy = {
  target?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  directPolicy?: "allow" | "block";
};

async function resolveProactiveOwnerRoute(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  policy?: ProactiveDeliveryPolicy;
}): Promise<{ plugin: ChannelPlugin; ownerId: string; reuseSessionRoute: boolean } | undefined> {
  const session = deliveryContextFromSession(params.entry);
  const plugins: Array<{ plugin: ChannelPlugin; accountId: string }> = [];
  const seen = new Set<string>();
  const add = (plugin: ChannelPlugin | undefined) => {
    if (
      !plugin ||
      !isDeliverableMessageChannel(plugin.id) ||
      seen.has(plugin.id) ||
      (params.policy?.channel && params.policy.channel !== plugin.id)
    ) {
      return;
    }
    seen.add(plugin.id);
    const accountId =
      params.policy?.accountId?.trim() ||
      (session?.channel === plugin.id ? session.accountId : undefined) ||
      resolveChannelDefaultAccountId({ plugin, cfg: params.cfg });
    // Owner discovery also runs in status. Exclude cold accounts before any
    // credential-dependent accessor; stale owners retain their active values.
    if (!isSecretOwnerAvailable("account", `${plugin.id}:${normalizeAccountId(accountId)}`)) {
      return;
    }
    const inspected = asOptionalRecord(plugin.config.inspectAccount?.(params.cfg, accountId));
    if (
      inspected?.enabled === false ||
      inspected?.configured === false ||
      hasConfiguredUnavailableCredentialStatus(inspected)
    ) {
      return;
    }
    plugins.push({ plugin, accountId });
  };
  if (session?.channel) {
    add(resolveOutboundChannelPlugin({ channel: session.channel, cfg: params.cfg }));
  }
  for (const plugin of listRuntimeVisibleChannelPlugins()) {
    if (await isPotentialConfiguredMessageChannel({ cfg: params.cfg, plugin })) {
      add(plugin);
    }
  }

  const buildRoute = (plugin: ChannelPlugin, ownerId: string) => ({
    plugin,
    ownerId,
    reuseSessionRoute:
      session?.channel === plugin.id &&
      Boolean(session.to) &&
      normalizeChatType(params.entry?.chatType) === "direct" &&
      ownerIdMatchesRoute(plugin, ownerId, session.to ?? ""),
  });

  // commands.ownerAllowFrom is the documented higher-priority owner identity:
  // exhaust it across every eligible channel before any channel-local
  // allowFrom fallback, or a session channel's fallback shadows a prefixed
  // configured owner on a later channel.
  const configuredOwners = concreteAllowFromEntries(params.cfg.commands?.ownerAllowFrom);
  for (const { plugin } of plugins) {
    const configuredOwner = configuredOwners.find((ownerId) => {
      const prefixedChannel = resolveTargetPrefixedChannel(ownerId);
      return (
        (!prefixedChannel || prefixedChannel === plugin.id) &&
        isPositivelyDirectOwnerTarget({ plugin, to: ownerId })
      );
    });
    if (configuredOwner) {
      return buildRoute(plugin, configuredOwner);
    }
  }
  for (const { plugin, accountId } of plugins) {
    const ownerId = concreteAllowFromEntries(
      await resolveChannelAllowFrom({
        plugin,
        cfg: params.cfg,
        accountId,
      }),
    )[0];
    if (ownerId) {
      return buildRoute(plugin, ownerId);
    }
  }
  return undefined;
}

/** Read-only owner-route probe for status/doctor surfaces. Unproven targets fail closed. */
export async function hasResolvableProactiveOwnerRoute(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  entry?: SessionEntry;
  policy?: ProactiveDeliveryPolicy;
}): Promise<boolean> {
  const delivery = await resolveProactiveDeliveryTarget({
    ...params,
    policy: { ...params.policy, target: "owner" },
  });
  return delivery.channel !== "none" && Boolean(delivery.to);
}

/**
 * Resolves proactive delivery. Owner/unset ignores `to`; only explicit channels consume it.
 */
export async function resolveProactiveDeliveryTarget(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  entry?: SessionEntry;
  policy?: ProactiveDeliveryPolicy;
}): Promise<OutboundTarget> {
  const { cfg, entry } = params;
  const policy = params.policy;
  const rawTarget = policy?.target;
  const implicitDefaultRoute = rawTarget === undefined;
  let target = implicitDefaultRoute ? "owner" : "none";
  let preparedExplicitPlugin: ChannelPlugin | undefined;
  let preparedExplicitTo: string | undefined;
  if (rawTarget === "none" || rawTarget === "last" || rawTarget === "owner") {
    target = rawTarget;
  } else if (typeof rawTarget === "string") {
    const normalized = normalizeDeliverableOutboundChannel(rawTarget);
    if (normalized) {
      target = normalized;
    } else {
      const explicitTo = policy?.to?.trim();
      if (explicitTo) {
        preparedExplicitPlugin = resolveOutboundChannelPlugin({
          channel: rawTarget,
          cfg,
          agentId: params.agentId,
          allowBootstrap: true,
        });
        if (preparedExplicitPlugin) {
          target = preparedExplicitPlugin.id;
          preparedExplicitTo = explicitTo;
        }
      }
    }
  }

  if (target === "none") {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoProactiveDeliveryTarget({ ...base, reason: "target-none", accountId: undefined });
  }

  const sessionDelivery = deliveryContextFromSession(entry);
  const ownerMode = target === "owner";
  const ownerRoute = ownerMode
    ? await resolveProactiveOwnerRoute({ cfg, entry, policy })
    : undefined;
  if (ownerMode && !ownerRoute) {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoProactiveDeliveryTarget({ ...base, reason: "no-route", accountId: undefined });
  }
  const ownerSession = ownerRoute?.reuseSessionRoute ? sessionDelivery : undefined;

  const resolvedTarget = resolveSessionDeliveryTarget({
    entry,
    mode: "heartbeat",
    ...(preparedExplicitPlugin && preparedExplicitTo
      ? { requestedChannel: target, explicitTo: preparedExplicitTo }
      : ownerRoute
        ? {
            requestedChannel: ownerRoute.plugin.id,
            explicitTo: ownerSession?.to ?? ownerRoute.ownerId,
            explicitThreadId: ownerSession?.threadId,
          }
        : {
            requestedChannel: target === "last" ? "last" : target,
            explicitTo: policy?.to,
          }),
  });

  const requestedAccountId = policy?.accountId?.trim();
  // Use explicit accountId from the delivery policy if provided, otherwise fall back to session
  let effectiveAccountId = requestedAccountId || resolvedTarget.accountId;
  const rejectDelivery = (reason: string, accountId = effectiveAccountId) =>
    buildNoProactiveDeliveryTarget({ ...resolvedTarget, reason, accountId });

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return rejectDelivery(target === "last" || ownerMode ? "no-route" : "no-target");
  }

  // Bootstrap once after a concrete route exists, then carry the prepared plugin
  // through account validation, target policy, and allow-from comparison.
  const preparedPlugin = preparedExplicitPlugin ?? ownerRoute?.plugin;
  const plugin =
    resolveOutboundChannelPlugin({
      channel: resolvedTarget.channel,
      cfg,
      agentId: params.agentId,
      allowBootstrap: true,
    }) ?? preparedPlugin;

  if (requestedAccountId) {
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(requestedAccountId);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return rejectDelivery(ownerMode ? "no-route" : "unknown-account", normalizedAccountId);
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  const targetParams = {
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: effectiveAccountId,
  };
  const resolved = await resolveOutboundTargetWithPlugin({
    plugin,
    target: {
      ...targetParams,
      allowFrom: ownerRoute ? [ownerRoute.ownerId] : undefined,
      mode: "heartbeat",
    },
  });
  if (!resolved?.ok) {
    return rejectDelivery(ownerMode ? "no-route" : "no-target");
  }

  // Chat type belongs to the stored channel/account/destination.
  // A dropped reply thread still shares its parent conversation's chat type.
  const sessionChatTypeHint =
    ((target === "last" && !policy?.to) || ownerRoute?.reuseSessionRoute) &&
    channelRouteTargetsMatchExact({
      left: { ...sessionDelivery, threadId: undefined },
      right: {
        channel: resolvedTarget.channel,
        to: resolvedTarget.to,
        accountId: effectiveAccountId,
      },
    })
      ? normalizeChatType(entry?.chatType)
      : undefined;
  const deliveryChatType =
    sessionChatTypeHint ??
    inferChatTypeFromTarget({ channel: resolvedTarget.channel, to: resolved.to, plugin });
  if (deliveryChatType === "direct" && policy?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (
    ownerMode &&
    !isPositivelyDirectOwnerTarget({
      plugin,
      to: resolved.to,
      chatType: deliveryChatType,
    })
  ) {
    return rejectDelivery("no-route");
  }

  let reason: string | undefined;
  if (plugin?.config.resolveAllowFromAsync || plugin?.config.resolveAllowFrom) {
    const explicit = await resolveOutboundTargetWithPlugin({
      plugin,
      target: { ...targetParams, mode: "explicit" },
    });
    if (explicit?.ok && explicit.to !== resolved.to) {
      reason = "allowFrom-fallback";
    }
  }

  const messaging = plugin
    ? plugin.messaging
    : resolveOutboundChannelPlugin({ channel: resolvedTarget.channel, cfg })?.messaging;
  const inheritedThreadId =
    messaging?.preserveHeartbeatThreadIdForGroupRoute === true &&
    resolvedTarget.threadId == null &&
    target === "last" &&
    !policy?.to &&
    resolvedTarget.channel === resolvedTarget.lastChannel &&
    Boolean(resolvedTarget.to) &&
    Boolean(resolvedTarget.lastTo) &&
    resolvedTarget.to === resolvedTarget.lastTo &&
    normalizeChatType(entry?.chatType) === "group"
      ? resolvedTarget.lastThreadId
      : undefined;

  return {
    channel: resolvedTarget.channel,
    to: resolved.to,
    chatType: deliveryChatType,
    reason,
    accountId: effectiveAccountId,
    // Proactive sends normally avoid inheriting session reply-thread IDs, but some
    // plugins encode thread/topic ids as part of the destination identity.
    threadId: resolvedTarget.threadId ?? inheritedThreadId,
    lastChannel: resolvedTarget.lastChannel,
    lastAccountId: resolvedTarget.lastAccountId,
    ...(implicitDefaultRoute ? { implicitDefaultRoute: true as const } : {}),
  };
}

function isPositivelyDirectOwnerTarget(params: {
  plugin?: ChannelPlugin;
  to: string;
  chatType?: ChatType;
}): boolean {
  const to = params.plugin
    ? stripTargetProviderPrefix(
        params.to,
        params.plugin.id,
        ...(params.plugin.messaging?.targetPrefixes ?? []),
      )
    : params.to.trim();
  const chatType =
    normalizeChatType(params.chatType) ?? params.plugin?.messaging?.inferTargetChatType?.({ to });
  // Implicit delivery must prove a direct destination via the channel's own
  // classifier; syntax alone (even `user:`) never admits, so unclassified
  // shapes fail closed and operator alerts cannot escape into a shared chat.
  return chatType === "direct";
}

function buildNoProactiveDeliveryTarget(params: {
  reason: string;
  accountId?: string;
  lastChannel?: string;
  lastAccountId?: string;
}): OutboundTarget {
  return {
    channel: "none",
    reason: params.reason,
    accountId: params.accountId,
    lastChannel: params.lastChannel,
    lastAccountId: params.lastAccountId,
  };
}

/** Resolves proactive delivery and lets plugins refine the outbound session route. */
export async function resolveProactiveDeliveryTargetWithSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry?: SessionEntry;
  policy?: ProactiveDeliveryPolicy;
  currentSessionKey?: string;
}): Promise<OutboundTarget> {
  const delivery = await resolveProactiveDeliveryTarget(params);
  const policy = params.policy;
  const ownerRouteMustBeDirect = policy?.target === undefined || policy.target === "owner";
  if (delivery.channel === "none" || !delivery.to) {
    return delivery;
  }
  const rejectDelivery = (reason: string) =>
    buildNoProactiveDeliveryTarget({ ...delivery, reason });
  const deliveryTo = delivery.to;
  const plugin = resolveOutboundChannelPlugin({
    channel: delivery.channel,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  const resolveSessionRoute = plugin?.messaging?.resolveOutboundSessionRoute;
  const isRejectedOwnerTarget = (to: string, chatType?: ChatType) =>
    ownerRouteMustBeDirect && !isPositivelyDirectOwnerTarget({ plugin, to, chatType });
  if (isRejectedOwnerTarget(deliveryTo, delivery.chatType)) {
    return rejectDelivery("no-route");
  }
  if (!resolveSessionRoute && !plugin?.messaging?.targetResolver) {
    return delivery;
  }
  let routeResolvedTarget: ResolvedMessagingTarget | undefined;
  // Target normalization failure should not suppress an otherwise deliverable target.
  const targetResolution = await resolveChannelTarget({
    cfg: params.cfg,
    channel: delivery.channel as ChannelId,
    input: deliveryTo,
    accountId: delivery.accountId,
    unknownTargetMode: "normalized",
    plugin,
  }).catch(() => null);
  if (targetResolution?.ok) {
    routeResolvedTarget = targetResolution.target;
  } else if (targetResolution && isReservedTargetLiteralError(targetResolution.error)) {
    return rejectDelivery(ownerRouteMustBeDirect ? "no-route" : "no-target");
  }
  if (routeResolvedTarget?.kind === "user" && policy?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (isRejectedOwnerTarget(routeResolvedTarget?.to ?? deliveryTo)) {
    return rejectDelivery("no-route");
  }
  if (!resolveSessionRoute) {
    return delivery;
  }
  const route = await resolveOutboundSessionRoute({
    cfg: params.cfg,
    channel: delivery.channel as ChannelId,
    plugin,
    agentId: params.agentId,
    accountId: delivery.accountId,
    target: routeResolvedTarget?.to ?? deliveryTo,
    ...(ownerRouteMustBeDirect ? { deliveryPurpose: "heartbeat-owner" as const } : {}),
    resolvedTarget: routeResolvedTarget,
    currentSessionKey: params.currentSessionKey,
    threadId: delivery.threadId,
  }).catch(() => null);
  if (!route) {
    return delivery;
  }
  if (route.chatType === "direct" && policy?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (isRejectedOwnerTarget(route.to, normalizeChatType(route.chatType))) {
    return rejectDelivery("no-route");
  }
  return {
    ...delivery,
    to: route.to,
    chatType: route.chatType,
    threadId: route.threadId ?? delivery.threadId,
    ...(route.recipientSessionExact === true ? { targetSessionKey: route.sessionKey } : {}),
  };
}

function inferChatTypeFromTarget(params: {
  channel: string;
  to: string;
  plugin?: ChannelPlugin;
}): ChatType | undefined {
  const to = params.to.trim();
  if (!to) {
    return undefined;
  }

  if (/^user:/i.test(to)) {
    return "direct";
  }
  if (/^(channel:|thread:)/i.test(to)) {
    return "channel";
  }
  if (/^group:/i.test(to)) {
    return "group";
  }
  const plugin =
    params.plugin ??
    resolveOutboundChannelPlugin({
      channel: params.channel,
    });
  return plugin?.messaging?.inferTargetChatType?.({ to }) ?? undefined;
}
