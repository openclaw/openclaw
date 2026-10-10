import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { isSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { mergeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import {
  resolveTargetPrefixedChannel,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import {
  hasDeliverableHeartbeatTurnSource,
  heartbeatExecRouteKey,
  normalizeHeartbeatExecRoute,
  isPositivelyDirectHeartbeatOwnerTarget,
} from "./heartbeat-route-context.js";
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

/** Sender identity context used when a heartbeat needs channel-compatible metadata. */
type HeartbeatSenderContext = {
  sender: string;
  provider?: string;
  allowFrom: string[];
};

type HeartbeatDeliveryParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  entry?: SessionEntry;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  turnSource?: DeliveryContext;
  /** Only admitted exec completion occurrences own the captured delivery route. */
  turnSourceKind?: "exec";
};

export type { OutboundTargetResolution } from "./targets-resolve-shared.js";
export { resolveSessionDeliveryTarget, type SessionDeliveryTarget } from "./targets-session.js";

/** Resolves a user-supplied outbound destination through the channel plugin. */
export function resolveOutboundTarget(
  params: ResolveOutboundTargetParams & { plugin?: ChannelPlugin; allowBootstrap?: boolean },
): OutboundTargetResolution {
  return (
    resolveOutboundTargetWithPlugin({
      plugin:
        params.plugin ??
        resolveOutboundChannelPlugin({
          channel: params.channel,
          cfg: params.cfg,
          allowBootstrap: params.allowBootstrap,
        }),
      target: params,
    }) ?? {
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

async function resolveHeartbeatOwnerRoute(
  params: Pick<HeartbeatDeliveryParams, "cfg" | "entry" | "heartbeat">,
): Promise<{ plugin: ChannelPlugin; ownerId: string; reuseSessionRoute: boolean } | undefined> {
  const session = deliveryContextFromSession(params.entry);
  const plugins: Array<{ plugin: ChannelPlugin; accountId: string }> = [];
  const seen = new Set<string>();
  const add = (plugin: ChannelPlugin | undefined) => {
    if (!plugin || !isDeliverableMessageChannel(plugin.id) || seen.has(plugin.id)) {
      return;
    }
    seen.add(plugin.id);
    const accountId =
      params.heartbeat?.accountId?.trim() ||
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
        isPositivelyDirectHeartbeatOwnerTarget({ plugin, to: ownerId })
      );
    });
    if (configuredOwner) {
      return buildRoute(plugin, configuredOwner);
    }
  }
  for (const { plugin, accountId } of plugins) {
    const ownerId = concreteAllowFromEntries(
      plugin.config.resolveAllowFrom?.({
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
export async function hasResolvableHeartbeatOwnerRoute(
  params: Omit<HeartbeatDeliveryParams, "turnSource" | "turnSourceKind">,
): Promise<boolean> {
  const delivery = await resolveHeartbeatDeliveryTarget({
    ...params,
    heartbeat: { ...params.heartbeat, target: "owner" },
  });
  return delivery.channel !== "none" && Boolean(delivery.to);
}

/**
 * Resolves heartbeat delivery. Owner/unset ignores `to`; only explicit channels consume it.
 */
export async function resolveHeartbeatDeliveryTarget(
  params: HeartbeatDeliveryParams,
): Promise<OutboundTarget> {
  const { cfg, entry } = params;
  const heartbeat = params.heartbeat ?? cfg.agents?.defaults?.heartbeat;
  const rawTarget = heartbeat?.target;
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
      const explicitTo = heartbeat?.to?.trim();
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
    return buildNoHeartbeatDeliveryTarget({ ...base, reason: "target-none", accountId: undefined });
  }

  const execOwnsRoute = params.turnSourceKind === "exec";
  const sourcePlugin =
    execOwnsRoute && params.turnSource?.channel
      ? resolveOutboundChannelPlugin({
          channel: params.turnSource.channel,
          cfg,
          agentId: params.agentId,
          allowBootstrap: true,
        })
      : undefined;
  const turnSource = execOwnsRoute
    ? normalizeHeartbeatExecRoute({ ...params.turnSource }, sourcePlugin)
    : params.turnSource;
  if (execOwnsRoute && !hasDeliverableHeartbeatTurnSource(turnSource)) {
    return buildNoHeartbeatDeliveryTarget({ reason: "no-route" });
  }
  const sessionDelivery = deliveryContextFromSession(entry);
  const ownerMode = target === "owner";
  const ownerTurnSource = ownerMode && hasDeliverableHeartbeatTurnSource(turnSource);
  const resolvedTurnSource = execOwnsRoute
    ? turnSource
    : target === "last" || ownerTurnSource
      ? mergeDeliveryContext(turnSource, sessionDelivery)
      : undefined;
  const ownerRoute =
    ownerMode && !ownerTurnSource
      ? await resolveHeartbeatOwnerRoute({ cfg, entry, heartbeat })
      : undefined;
  if (ownerMode && !ownerTurnSource && !ownerRoute) {
    const base = resolveSessionDeliveryTarget({ entry });
    return buildNoHeartbeatDeliveryTarget({ ...base, reason: "no-route", accountId: undefined });
  }
  const ownerSession = ownerRoute?.reuseSessionRoute ? sessionDelivery : undefined;

  const resolvedTarget = resolveSessionDeliveryTarget({
    entry,
    mode: "heartbeat",
    ...(execOwnsRoute
      ? {
          requestedChannel: "last",
          turnSourceChannel: turnSource?.channel,
          turnSourceTo: turnSource?.to,
          turnSourceAccountId: turnSource?.accountId,
          turnSourceThreadId: turnSource?.threadId,
        }
      : preparedExplicitPlugin && preparedExplicitTo
        ? {
            requestedChannel: target,
            explicitTo: preparedExplicitTo,
          }
        : ownerRoute
          ? {
              requestedChannel: ownerRoute.plugin.id,
              explicitTo: ownerSession?.to ?? ownerRoute.ownerId,
              explicitThreadId: ownerSession?.threadId,
            }
          : {
              requestedChannel: target === "last" || ownerTurnSource ? "last" : target,
              explicitTo: ownerMode ? undefined : heartbeat?.to,
              turnSourceChannel:
                resolvedTurnSource?.channel &&
                isDeliverableMessageChannel(resolvedTurnSource.channel)
                  ? resolvedTurnSource.channel
                  : undefined,
              turnSourceTo: resolvedTurnSource?.to,
              turnSourceAccountId: resolvedTurnSource?.accountId,
              // Explicit wake origins own their thread. Session-only threads stay dropped;
              // reusing one could post a later heartbeat into a stale conversation.
              turnSourceThreadId: turnSource?.threadId,
            }),
  });

  const heartbeatAccountId =
    execOwnsRoute || ownerTurnSource ? undefined : heartbeat?.accountId?.trim();
  // Use explicit accountId from heartbeat config if provided, otherwise fall back to session
  let effectiveAccountId = heartbeatAccountId || resolvedTarget.accountId;
  const rejectDelivery = (reason: string, accountId = effectiveAccountId) =>
    buildNoHeartbeatDeliveryTarget({ ...resolvedTarget, reason, accountId });

  if (!resolvedTarget.channel || !resolvedTarget.to) {
    return rejectDelivery(target === "last" || ownerMode ? "no-route" : "no-target");
  }

  // Bootstrap once after a concrete route exists, then carry the prepared plugin
  // through account validation, target policy, and allow-from comparison.
  const preparedPlugin = execOwnsRoute ? undefined : (preparedExplicitPlugin ?? ownerRoute?.plugin);
  const plugin =
    resolveOutboundChannelPlugin({
      channel: resolvedTarget.channel,
      cfg,
      agentId: params.agentId,
      allowBootstrap: true,
    }) ?? preparedPlugin;

  const accountToValidate = execOwnsRoute ? effectiveAccountId : heartbeatAccountId;
  if (accountToValidate) {
    const listAccountIds = plugin?.config.listAccountIds;
    const accountIds = listAccountIds ? listAccountIds(cfg) : [];
    if (accountIds.length > 0) {
      const normalizedAccountId = normalizeAccountId(accountToValidate);
      const normalizedAccountIds = new Set(
        accountIds.map((accountId) => normalizeAccountId(accountId)),
      );
      if (!normalizedAccountIds.has(normalizedAccountId)) {
        return rejectDelivery(ownerMode ? "no-route" : "unknown-account", normalizedAccountId);
      }
      effectiveAccountId = normalizedAccountId;
    }
  }

  const execRouteKey = execOwnsRoute
    ? heartbeatExecRouteKey({ ...turnSource, accountId: effectiveAccountId }, plugin)
    : undefined;
  if (execOwnsRoute && execRouteKey === undefined) {
    return rejectDelivery("exec-route-conflict");
  }
  const targetParams = {
    channel: resolvedTarget.channel,
    to: resolvedTarget.to,
    cfg,
    accountId: effectiveAccountId,
  };
  const resolved = resolveOutboundTargetWithPlugin({
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

  if (
    execOwnsRoute &&
    execRouteKey !==
      heartbeatExecRouteKey(
        { ...resolvedTarget, to: resolved.to, accountId: effectiveAccountId },
        plugin,
      )
  ) {
    return rejectDelivery("exec-route-conflict");
  }

  // Chat type belongs to the stored channel/account/destination, not a later wake route.
  // A dropped reply thread still shares its parent conversation's chat type.
  const sessionChatTypeHint =
    ((target === "last" && !heartbeat?.to) || ownerRoute?.reuseSessionRoute) &&
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
  if (deliveryChatType === "direct" && heartbeat?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (
    ownerMode &&
    !ownerTurnSource &&
    !isPositivelyDirectHeartbeatOwnerTarget({
      plugin,
      to: resolved.to,
      chatType: deliveryChatType,
    })
  ) {
    return rejectDelivery("no-route");
  }

  let reason: string | undefined;
  if (plugin?.config.resolveAllowFrom) {
    const explicit = resolveOutboundTargetWithPlugin({
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
  const inheritedHeartbeatThreadId =
    !execOwnsRoute &&
    messaging?.preserveHeartbeatThreadIdForGroupRoute === true &&
    resolvedTarget.threadId == null &&
    target === "last" &&
    !heartbeat?.to &&
    turnSource?.threadId == null &&
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
    // Heartbeats normally avoid inheriting session reply-thread IDs, but some
    // plugins encode thread/topic ids as part of the destination identity.
    threadId: resolvedTarget.threadId ?? inheritedHeartbeatThreadId,
    lastChannel: resolvedTarget.lastChannel,
    lastAccountId: resolvedTarget.lastAccountId,
    ...(implicitDefaultRoute ? { implicitDefaultRoute: true as const } : {}),
  };
}

function buildNoHeartbeatDeliveryTarget(params: {
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

/** Resolves heartbeat delivery and lets plugins refine the outbound session route. */
export async function resolveHeartbeatDeliveryTargetWithSessionRoute(
  params: HeartbeatDeliveryParams & { agentId: string; currentSessionKey?: string },
): Promise<OutboundTarget> {
  const delivery = await resolveHeartbeatDeliveryTarget({
    ...params,
    ...(params.turnSourceKind === "exec" ? { turnSource: { ...params.turnSource } } : {}),
  });
  const heartbeat = params.heartbeat ?? params.cfg.agents?.defaults?.heartbeat;
  const ownerRouteMustBeDirect =
    (heartbeat?.target === undefined || heartbeat.target === "owner") &&
    !hasDeliverableHeartbeatTurnSource(params.turnSource);
  if (delivery.channel === "none" || !delivery.to) {
    return delivery;
  }
  const rejectDelivery = (reason: string) =>
    buildNoHeartbeatDeliveryTarget({ ...delivery, reason });
  const deliveryTo = delivery.to;
  const plugin = resolveOutboundChannelPlugin({
    channel: delivery.channel,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  const execRouteKey =
    params.turnSourceKind === "exec" ? heartbeatExecRouteKey(delivery, plugin) : undefined;
  if (params.turnSourceKind === "exec" && execRouteKey === undefined) {
    return rejectDelivery("exec-route-conflict");
  }
  const resolveSessionRoute = plugin?.messaging?.resolveOutboundSessionRoute;
  const isRejectedOwnerTarget = (to: string, chatType?: ChatType) =>
    ownerRouteMustBeDirect && !isPositivelyDirectHeartbeatOwnerTarget({ plugin, to, chatType });
  if (isRejectedOwnerTarget(deliveryTo, delivery.chatType)) {
    return rejectDelivery("no-route");
  }
  if (!resolveSessionRoute && !plugin?.messaging?.targetResolver) {
    return delivery;
  }
  let routeResolvedTarget: ResolvedMessagingTarget | undefined;
  // Ordinary monitors retain normalization fallback; captured exec output cannot
  // be admitted after a declared target validator fails.
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
  if (execRouteKey !== undefined && !targetResolution?.ok) {
    return rejectDelivery("exec-route-conflict");
  }
  if (
    execRouteKey !== undefined &&
    routeResolvedTarget &&
    heartbeatExecRouteKey({ ...delivery, to: routeResolvedTarget.to }, plugin) !== execRouteKey
  ) {
    return rejectDelivery("exec-route-conflict");
  }
  if (routeResolvedTarget?.kind === "user" && heartbeat?.directPolicy === "block") {
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
  }).catch(() => undefined);
  // A null result declines optional session refinement; a thrown resolver did
  // not validate its result and cannot grant captured exec delivery.
  if (execRouteKey !== undefined && route === undefined) {
    return rejectDelivery("exec-route-conflict");
  }
  if (!route) {
    return delivery;
  }
  if (route.chatType === "direct" && heartbeat?.directPolicy === "block") {
    return rejectDelivery("dm-blocked");
  }
  if (isRejectedOwnerTarget(route.to, normalizeChatType(route.chatType))) {
    return rejectDelivery("no-route");
  }
  const refinedDelivery = {
    ...delivery,
    to: route.to,
    chatType: route.chatType,
    threadId: route.threadId ?? delivery.threadId,
    ...(route.recipientSessionExact === true ? { targetSessionKey: route.sessionKey } : {}),
  };
  if (
    execRouteKey !== undefined &&
    heartbeatExecRouteKey(refinedDelivery, plugin) !== execRouteKey
  ) {
    return rejectDelivery("exec-route-conflict");
  }
  return refinedDelivery;
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

/** Resolves the sender id/allow-list context used for heartbeat sends. */
export function resolveHeartbeatSenderContext(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  delivery: OutboundTarget;
}): HeartbeatSenderContext {
  const provider =
    params.delivery.channel !== "none" ? params.delivery.channel : params.delivery.lastChannel;
  const accountId =
    params.delivery.accountId ??
    (provider === params.delivery.lastChannel ? params.delivery.lastAccountId : undefined);
  const allowFromRaw = provider
    ? (resolveOutboundChannelPlugin({
        channel: provider,
        cfg: params.cfg,
      })?.config.resolveAllowFrom?.({
        cfg: params.cfg,
        accountId,
      }) ?? [])
    : [];
  const allowFrom = mapAllowFromEntries(allowFromRaw);

  const deliveryTo = params.delivery.to;
  const lastTo = deliveryContextFromSession(params.entry)?.to;
  const candidates = [
    deliveryTo?.trim(),
    provider && deliveryTo ? `${provider}:${deliveryTo}` : undefined,
    lastTo?.trim(),
    provider && lastTo ? `${provider}:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));
  const allowList = concreteAllowFromEntries(allowFrom);
  const sender = mapAllowFromEntries(allowFrom).some((entry) => entry.trim() === "*")
    ? (candidates[0] ?? "heartbeat")
    : (candidates.find((candidate) => allowList.includes(candidate)) ??
      allowList[0] ??
      candidates[0] ??
      "heartbeat");

  return { sender, provider, allowFrom };
}
