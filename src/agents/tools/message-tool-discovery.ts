import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import type { ChatType } from "../../channels/chat-type.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import {
  type ChannelMessageActionDiscoveryInput,
  listCrossChannelSchemaSupportedMessageActionsSteps,
  listMessageActionDiscoveryChannels,
  type MessageActionDiscoverySteps,
  type PreparedMessageToolCatalog,
  resolveChannelMessageToolSchemaPropertiesSteps,
  resolveCurrentMessageActionDiscoverySteps,
  runMessageActionDiscovery,
  runMessageActionDiscoveryAsync,
} from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { listRouteBindings } from "../../config/bindings.js";
import { readExactSessionDeliveryContext } from "../../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stripTargetProviderPrefix } from "../../infra/outbound/channel-target-prefix.js";
import { actionHasTarget } from "../../infra/outbound/message-action-spec.js";
import { resolveAllowedMessageActions } from "../../infra/outbound/outbound-policy.js";
import { normalizeRouteBindingChannelId } from "../../routing/binding-scope.js";
import {
  normalizeAccountId,
  normalizeAgentId,
  parseSessionDeliveryRoute,
} from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { listChannelSupportedActionsSteps } from "../channel-tools.js";
import { buildMessageToolSchemaFromActions } from "./message-tool-schema.js";
export type MessageToolDiscoveryParams = {
  cfg: OpenClawConfig;
  currentChatType?: ChatType;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentPromptReaction?: boolean;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  /** Host-redeemed scheduled turn, including trusted jobs without account scoping. */
  isScheduledRun?: boolean;
  /** Host-redeemed scheduled account; never changes the current delivery context. */
  scheduledAccountScope?: { channels?: readonly string[]; accountId: string };
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type MessageActionDiscoveryInput = Omit<ChannelMessageActionDiscoveryInput, "cfg" | "channel"> & {
  cfg: OpenClawConfig;
  channel?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type MessageToolCurrentContextOptions = {
  agentSessionKey?: string;
  sessionId?: string;
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
};
type InferredSessionDelivery = {
  accountId?: string;
  channel: string;
  chatType?: ChatType;
  threadId?: string;
  to: string;
};

function formatSessionDeliveryTarget(channel: string, peerKind: string, to: string): string {
  return (peerKind === "direct" || peerKind === "dm") &&
    getChannelPlugin(channel)?.messaging?.directTargetStyle === "user-prefixed"
    ? `user:${to}`
    : to;
}

function resolveSessionDeliveryChatType(peerKind: string): ChatType | undefined {
  if (peerKind === "direct" || peerKind === "dm") {
    return "direct";
  }
  return peerKind === "group" || peerKind === "channel" ? peerKind : undefined;
}

type MessageToolDeliveryRequest = {
  config: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  accountId?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

async function recoverSessionCanonicalPeerId(params: {
  channel: string;
  peerId: string;
  sessionKey?: string;
  sessionId?: string;
  request?: MessageToolDeliveryRequest;
}): Promise<string> {
  const { request } = params;
  if (
    !request ||
    normalizeOptionalString(request.params.target) ||
    (Array.isArray(request.params.targets) && request.params.targets.length > 0) ||
    actionHasTarget(request.action, request.params, {
      channel: params.channel,
      aliasSpec: request.preparedMessageToolCatalog
        ? (request.preparedMessageToolCatalog.getChannel(params.channel)?.actions
            ?.messageActionTargetAliases?.[request.action] ?? null)
        : undefined,
    })
  ) {
    return params.peerId;
  }
  const plugin = getChannelPlugin(params.channel);
  if (plugin?.messaging?.targetIdComparison !== "case-sensitive") {
    return params.peerId;
  }
  const delivery = await readExactSessionDeliveryContext({
    cfg: request.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  const accountId =
    request.accountId ??
    resolveChannelDefaultAccountId({
      plugin,
      cfg: request.config,
    });
  if (
    normalizeMessageChannel(delivery?.channel) !== params.channel ||
    normalizeAccountId(delivery?.accountId) !== normalizeAccountId(accountId)
  ) {
    return params.peerId;
  }
  const storedTo = normalizeOptionalString(delivery?.to);
  const canonical = storedTo
    ? stripTargetProviderPrefix(storedTo, params.channel, delivery?.channel ?? "")
    : undefined;
  return canonical && canonical.toLowerCase() === params.peerId.toLowerCase()
    ? canonical
    : params.peerId;
}

function inferDeliveryFromSessionKey(
  sessionKey: string | undefined,
  canonicalPeerId?: string,
): InferredSessionDelivery | null {
  const route = parseSessionDeliveryRoute(sessionKey);
  if (!route) {
    return null;
  }
  const channel = normalizeMessageChannel(route.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return null;
  }
  const accountId = route.accountId ? resolveAgentAccountId(route.accountId) : undefined;
  const peerId = canonicalPeerId ?? route.peerId;
  return {
    accountId,
    channel,
    chatType: resolveSessionDeliveryChatType(route.peerKind),
    threadId: route.threadId,
    to: formatSessionDeliveryTarget(channel, route.peerKind, peerId),
  };
}

export function resolveEffectiveCurrentChannelContext(options?: MessageToolCurrentContextOptions) {
  return projectCurrentChannelContext(
    options,
    inferDeliveryFromSessionKey(options?.agentSessionKey),
  );
}

/** Recover opaque peer casing through the session owner only when executing an inferred send. */
export async function resolveEffectiveCurrentChannelContextForRequest(
  options: MessageToolCurrentContextOptions | undefined,
  request?: MessageToolDeliveryRequest,
) {
  if (!request) {
    return resolveEffectiveCurrentChannelContext(options);
  }
  const route = parseSessionDeliveryRoute(options?.agentSessionKey);
  const channel = route && normalizeMessageChannel(route.channel);
  const peerId =
    route &&
    channel &&
    normalizeMessageChannel(options?.currentChannelProvider) === INTERNAL_MESSAGE_CHANNEL
      ? await recoverSessionCanonicalPeerId({
          request,
          channel,
          peerId: route.peerId,
          sessionKey: options?.agentSessionKey,
          sessionId: options?.sessionId,
        })
      : undefined;
  return projectCurrentChannelContext(
    options,
    inferDeliveryFromSessionKey(options?.agentSessionKey, peerId),
  );
}

function projectCurrentChannelContext(
  options: MessageToolCurrentContextOptions | undefined,
  inferred: InferredSessionDelivery | null,
): {
  accountId?: string;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
} {
  const currentChannelProvider = options?.currentChannelProvider;
  const currentChannelId = options?.currentChannelId;
  const sessionDelivery =
    normalizeMessageChannel(currentChannelProvider) === INTERNAL_MESSAGE_CHANNEL ? inferred : null;

  if (!sessionDelivery?.to) {
    return {
      currentChannelProvider,
      currentChannelId,
      currentChatType: options?.currentChatType,
      currentMessagingTarget: options?.currentMessagingTarget,
    };
  }
  return {
    accountId: sessionDelivery.accountId,
    currentChannelProvider: sessionDelivery.channel,
    currentChannelId: sessionDelivery.to,
    currentChatType: sessionDelivery.chatType,
    currentMessagingTarget: sessionDelivery.to,
    currentThreadTs: sessionDelivery.threadId,
  };
}

function resolveDiscoveryAccountId(
  params: MessageToolDiscoveryParams,
  channel: string | undefined,
  contextualAccountId: ChannelMessageActionDiscoveryInput["accountId"],
): ChannelMessageActionDiscoveryInput["accountId"] {
  const scope = params.scheduledAccountScope;
  const normalizedChannel = normalizeMessageChannel(channel);
  return scope &&
    (scope.channels === undefined ||
      (normalizedChannel !== undefined &&
        scope.channels.some(
          (scopedChannel) => normalizeMessageChannel(scopedChannel) === normalizedChannel,
        )))
    ? scope.accountId
    : contextualAccountId;
}

function buildMessageActionDiscoveryInput(
  params: MessageToolDiscoveryParams,
  channel?: string,
): MessageActionDiscoveryInput {
  return {
    cfg: params.cfg,
    ...(channel ? { channel } : {}),
    chatType: params.currentChatType,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: resolveDiscoveryAccountId(params, channel, params.currentAccountId),
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
    preparedMessageToolCatalog: params.preparedMessageToolCatalog,
  };
}

function resolveMessageToolDiscoveryChannels(params: MessageToolDiscoveryParams) {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  const boundChannels = new Set<string>();
  if (currentChannel && currentChannel !== INTERNAL_MESSAGE_CHANNEL) {
    boundChannels.add(currentChannel);
  }
  if (params.agentId) {
    for (const binding of listRouteBindings(params.cfg)) {
      const channel = normalizeRouteBindingChannelId(binding.match.channel);
      if (channel && normalizeAgentId(binding.agentId) === normalizeAgentId(params.agentId)) {
        boundChannels.add(channel);
      }
    }
  }
  // Scheduled authority scopes accounts, not destinations. Unbound local runs
  // also retain the configured union; channel sessions only need their bindings.
  return listMessageActionDiscoveryChannels(params.preparedMessageToolCatalog)
    .filter(
      (plugin) => params.isScheduledRun || boundChannels.size === 0 || boundChannels.has(plugin.id),
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function* resolveMessageToolSchemaActionsSteps(
  params: MessageToolDiscoveryParams,
): MessageActionDiscoverySteps<string[]> {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  const actions = new Set<string>(currentChannel ? ["send"] : ["send", "broadcast"]);
  if (currentChannel) {
    for (const action of yield* listChannelSupportedActionsSteps(
      buildMessageActionDiscoveryInput(params, currentChannel),
    )) {
      actions.add(action);
    }
  }
  for (const plugin of resolveMessageToolDiscoveryChannels(params)) {
    if (plugin.id === currentChannel) {
      continue;
    }
    const input = buildMessageActionDiscoveryInput(params, plugin.id);
    const discovered = currentChannel
      ? yield* listCrossChannelSchemaSupportedMessageActionsSteps(input)
      : yield* listChannelSupportedActionsSteps(input);
    for (const action of discovered) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

export function resolveMessageToolActionSchemaActions(
  params: MessageToolDiscoveryParams,
): string[] {
  return runMessageActionDiscovery(resolveMessageToolActionSchemaActionsSteps(params));
}

function* resolveMessageToolActionSchemaActionsSteps(
  params: MessageToolDiscoveryParams,
): MessageActionDiscoverySteps<string[]> {
  const discoveredActions = yield* resolveMessageToolSchemaActionsSteps(params);
  if (params.currentPromptReaction && !discoveredActions.includes("react")) {
    discoveredActions.push("react");
  }
  const allowedActions = resolveAllowedMessageActions({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!allowedActions) {
    return sortUniqueStrings(discoveredActions);
  }
  const allow = new Set(allowedActions);
  const filtered = discoveredActions.filter((action) => allow.has(action));
  return sortUniqueStrings(filtered.length > 0 ? filtered : allowedActions);
}

function* resolveIncludeCapabilitySteps(
  params: MessageToolDiscoveryParams,
  capability: ChannelMessageCapability,
): MessageActionDiscoverySteps<boolean> {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    const discovered = yield* resolveCurrentMessageActionDiscoverySteps(
      buildMessageActionDiscoveryInput(params, currentChannel),
      { includeCapabilities: true },
    );
    if (discovered?.capabilities.includes(capability)) {
      return true;
    }
  }
  for (const plugin of resolveMessageToolDiscoveryChannels(params)) {
    if (plugin.id === currentChannel) {
      continue;
    }
    const accountId = resolveDiscoveryAccountId(params, plugin.id, undefined);
    const discovered = yield {
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg: params.cfg, ...(accountId !== undefined ? { accountId } : {}) },
      includeCapabilities: true,
    };
    if (discovered.capabilities.includes(capability)) {
      return true;
    }
  }
  return false;
}

function resolveIncludeBestEffort(params: MessageToolDiscoveryParams): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (!currentChannel) {
    return false;
  }
  const prepared = params.preparedMessageToolCatalog?.getChannel(currentChannel);
  if (params.preparedMessageToolCatalog) {
    // The prepared catalog is the exact runtime-registry generation for this
    // turn. A missing channel is an authoritative absence, not permission to
    // rediscover bundled plugins on the request path.
    return prepared?.reconcilesUnknownSend ?? false;
  }
  const adapter =
    getLoadedChannelPlugin(currentChannel as Parameters<typeof getLoadedChannelPlugin>[0])
      ?.message ??
    getChannelPlugin(currentChannel as Parameters<typeof getChannelPlugin>[0])?.message;
  return (
    adapter?.durableFinal?.capabilities?.reconcileUnknownSend === true &&
    typeof adapter.durableFinal.reconcileUnknownSend === "function"
  );
}

export function buildMessageToolSchema(params: MessageToolDiscoveryParams, actions: string[]) {
  return runMessageActionDiscovery(buildMessageToolSchemaSteps(params, actions));
}

function* buildMessageToolSchemaSteps(
  params: MessageToolDiscoveryParams,
  actions: string[],
): MessageActionDiscoverySteps<ReturnType<typeof buildMessageToolSchemaFromActions>> {
  const includePresentation = yield* resolveIncludeCapabilitySteps(params, "presentation");
  const includeDeliveryPin = yield* resolveIncludeCapabilitySteps(params, "delivery-pin");
  const includeBestEffort = resolveIncludeBestEffort(params);
  const extraProperties = yield* resolveChannelMessageToolSchemaPropertiesSteps({
    channels: resolveMessageToolDiscoveryChannels(params),
    ...buildMessageActionDiscoveryInput(
      params,
      normalizeMessageChannel(params.currentChannelProvider) ?? undefined,
    ),
    resolveAccountIdForChannel: params.scheduledAccountScope
      ? (channel, contextualAccountId) =>
          resolveDiscoveryAccountId(params, channel, contextualAccountId)
      : undefined,
  });
  return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
    includeClawHub:
      normalizeMessageChannel(params.currentChannelProvider) === INTERNAL_MESSAGE_CHANNEL,
    includePresentation,
    includeDeliveryPin,
    includeBestEffort,
    extraProperties:
      params.currentPromptReaction && actions.includes("react")
        ? {
            ...extraProperties,
            emoji: Type.Optional(
              Type.String({
                description:
                  "One Unicode emoji for the current WebChat prompt; explicit external channels validate their own emoji.",
              }),
            ),
          }
        : extraProperties,
  });
}

export function resolveMessageToolDiscoveryAsync(params: MessageToolDiscoveryParams) {
  return runMessageActionDiscoveryAsync(resolveMessageToolDiscoverySteps(params));
}

function* resolveMessageToolDiscoverySteps(
  params: MessageToolDiscoveryParams,
): MessageActionDiscoverySteps<{
  actions: string[];
  schema: ReturnType<typeof buildMessageToolSchemaFromActions>;
}> {
  const actions = yield* resolveMessageToolActionSchemaActionsSteps(params);
  const schema = yield* buildMessageToolSchemaSteps(params, actions);
  return { actions, schema };
}

export function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? normalizeAccountId(trimmed) : undefined;
}

export function buildMessageToolDescription(actions: string[] | undefined): string {
  const baseDescription = "Send/manage channel messages.";
  if (actions && actions.length > 0) {
    const sortedActions = sortUniqueStrings(actions);
    const description = `${baseDescription} Supports actions: ${sortedActions.join(", ")}.`;
    return sortedActions.includes("read")
      ? `${description} Missing thread context: action="read" + threadId.`
      : description;
  }
  return `${baseDescription} Action families (availability depends on the channel): sending/editing/unsend, reactions, polls, pins, threads, file upload/download, moderation (timeout/kick/ban), roles, channel + category management, profile/presence.`;
}
