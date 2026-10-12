import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import {
  resolveConfiguredBindingRoute,
  inspectRuntimeConversationBindingRoute,
} from "../channels/plugins/binding-routing.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import { listRouteBindings } from "../config/bindings.js";
import { assertConversationAuthority } from "../config/sessions/conversation-authority.js";
import type { ConversationAuthority } from "../config/sessions/conversation-authority.types.js";
import { getConversationDeliveryOperation } from "../config/sessions/conversation-delivery-store.js";
import {
  withConversationAuthority,
  readConversation,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import type { ConversationRouteContext } from "../config/sessions/conversation-route-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import {
  type inspectSessionBindingByConversation,
  inspectSessionBindingsByConversations,
  prepareSessionBindingInspections,
} from "../infra/outbound/session-binding-service.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingId } from "../routing/binding-scope.js";
import { peerKindMatches } from "../routing/peer-kind-match.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";

type ConversationRouteCandidate = Pick<
  ConversationRecord,
  "accountId" | "channel" | "kind" | "parentConversationRef" | "peerId" | "target" | "threadId"
> & {
  nativeChannelId?: string;
  routeContext?: ConversationRouteContext;
  routeContextObserved?: true;
};

type ConversationRouteEligibility = "eligible" | "denied" | "unavailable";

type RouteOwnerResolution = { kind: "available"; agentId?: string } | { kind: "unavailable" };

function hasActivePluginClaimOwner(pluginId: string): boolean {
  return (
    getGlobalPluginRegistry()?.typedHooks.some(
      (hook) => hook.pluginId === pluginId && hook.hookName === "inbound_claim",
    ) === true
  );
}

type PluginRouteOwnerResolver = NonNullable<
  ChannelMessagingAdapter["resolveConversationRouteOwner"]
>;
function pluginRouteOwnerInput(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
): Parameters<PluginRouteOwnerResolver>[0] {
  return {
    cfg: config,
    accountId: normalizeAccountId(conversation.accountId),
    conversation: {
      kind: conversation.kind,
      peerId: conversation.peerId,
      target: conversation.target,
      ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
      ...(conversation.nativeChannelId ? { nativeChannelId: conversation.nativeChannelId } : {}),
      ...(conversation.routeContext ? { context: conversation.routeContext } : {}),
    },
  };
}

function resolvePluginRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  preparedResolver?: PluginRouteOwnerResolver,
): RouteOwnerResolution | undefined {
  const channelId = normalizeChannelId(conversation.channel);
  const resolver =
    preparedResolver ??
    (channelId
      ? getLoadedChannelPlugin(channelId)?.messaging?.resolveConversationRouteOwner
      : undefined);
  if (!resolver) {
    return undefined;
  }
  if (!preparedResolver)
    warnPluginSdkDeprecation({
      family: "conversation-route-ownership",
      method: "ChannelMessagingAdapter.resolveConversationRouteOwner",
      replacement: "ChannelMessagingAdapter.prepareConversationRouteOwnersAsync",
    });
  try {
    const owner = resolver(pluginRouteOwnerInput(config, conversation));
    if (owner === undefined) {
      return undefined;
    }
    if (owner === null) {
      return { kind: "available" };
    }
    if (owner.kind === "unavailable") {
      return owner;
    }
    if (owner.kind === "plugin") {
      return hasActivePluginClaimOwner(owner.pluginId)
        ? { kind: "available" }
        : { kind: "available", agentId: normalizeAgentId(owner.fallbackAgentId) };
    }
    return { kind: "available", agentId: normalizeAgentId(owner.agentId) };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return { kind: "available" };
    }
    throw error;
  }
}

function resolveConfiguredRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  context?: ConversationRouteContext,
): ResolvedAgentRoute | undefined {
  try {
    return resolveAgentRoute({
      cfg: config,
      channel: conversation.channel,
      accountId: conversation.accountId,
      peer: { kind: conversation.kind, id: conversation.peerId },
      ...(context?.parentPeerId && conversation.kind !== "direct"
        ? { parentPeer: { kind: conversation.kind, id: context.parentPeerId } }
        : {}),
      ...(context?.guildId ? { guildId: context.guildId } : {}),
      ...(context?.teamId ? { teamId: context.teamId } : {}),
      ...(context?.memberRoleIds ? { memberRoleIds: context.memberRoleIds } : {}),
    });
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return undefined;
    }
    throw error;
  }
}

function prepareGenericRoute(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
  route: ResolvedAgentRoute;
  context?: ConversationRouteContext;
}) {
  const conversation = {
    channel: params.conversation.channel,
    accountId: normalizeAccountId(params.conversation.accountId),
    conversationId: params.conversation.peerId,
    ...(params.context?.parentPeerId ? { parentConversationId: params.context.parentPeerId } : {}),
  };
  const configured = resolveConfiguredBindingRoute({
    cfg: params.config,
    route: params.route,
    conversation,
  });
  return { conversation, route: configured.route };
}

function resolveInspectedGenericRouteOwner(
  route: ResolvedAgentRoute,
  inspection: ReturnType<typeof inspectSessionBindingByConversation>,
): RouteOwnerResolution {
  const runtime = inspectRuntimeConversationBindingRoute({ route, inspection });
  if (runtime.bindingOwnerAvailable === false) {
    return { kind: "unavailable" };
  }
  if (runtime.pluginId && hasActivePluginClaimOwner(runtime.pluginId)) {
    return { kind: "available" };
  }
  return { kind: "available", agentId: normalizeAgentId(runtime.route.agentId) };
}

function bindingPeerCouldMatchConversation(
  binding: ReturnType<typeof listRouteBindings>[number],
  conversation: ConversationRouteCandidate,
): boolean {
  // Before routePeer persistence, migration derived peerId from the delivery target, so topic
  // rows retain their parent chat there. Current child peers always carry observed parent context.
  // Treating every same-kind peer as a possible parent would let unrelated bindings deny valid routes.
  const peer = binding.match.peer;
  if (!peer) {
    return true;
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeRouteBindingId(peer.id);
  if (!kind || !id) {
    return false;
  }
  return peerKindMatches(kind, conversation.kind) && (id === "*" || id === conversation.peerId);
}

function hasUnrecordedContextualBinding(params: {
  config: OpenClawConfig;
  conversation: ConversationRouteCandidate;
  resolvedAgentId: string;
}): boolean {
  const channel = normalizeLowercaseStringOrEmpty(params.conversation.channel);
  const accountId = normalizeAccountId(params.conversation.accountId);
  const hasThreadContext = Boolean(
    params.conversation.parentConversationRef || params.conversation.threadId,
  );
  const hasGuildContext = params.conversation.kind === "channel";
  return listRouteBindings(params.config).some((binding) => {
    const pattern = binding.match.accountId?.trim() ?? "";
    const contextualScope = Boolean(
      (hasGuildContext && normalizeRouteBindingId(binding.match.guildId)) ||
      normalizeRouteBindingId(binding.match.teamId) ||
      (hasGuildContext && binding.match.roles?.length) ||
      (hasThreadContext &&
        binding.match.peer?.kind !== "direct" &&
        normalizeRouteBindingId(binding.match.peer?.id)),
    );
    return (
      contextualScope &&
      normalizeAgentId(binding.agentId) !== params.resolvedAgentId &&
      normalizeLowercaseStringOrEmpty(binding.match.channel) === channel &&
      (pattern === "*" || normalizeAccountId(pattern) === accountId) &&
      bindingPeerCouldMatchConversation(binding, params.conversation)
    );
  });
}

type RouteEligibilityInput = {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate;
};

function finishRouteEligibility(
  params: RouteEligibilityInput,
  owner: RouteOwnerResolution,
): ConversationRouteEligibility {
  if (owner.kind === "unavailable") {
    return "unavailable";
  }
  if (owner.agentId !== normalizeAgentId(params.agentId)) {
    return "denied";
  }
  return !params.conversation.routeContextObserved &&
    !params.conversation.routeContext &&
    hasUnrecordedContextualBinding({
      config: params.config,
      conversation: params.conversation,
      resolvedAgentId: owner.agentId,
    })
    ? "denied"
    : "eligible";
}

/** Prepare native reads once; effect callbacks only consume owner-held facts and receipt invalidation. */
export async function prepareConversationRouteEligibilitiesForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversations: readonly ConversationRouteCandidate[];
}) {
  const inputs = params.conversations.map((conversation) => ({
    config: params.config,
    agentId: params.agentId,
    conversation,
  }));
  const releases: Array<() => void> = [];
  const inspectBindings = async (refs: Parameters<typeof prepareSessionBindingInspections>[0]) => {
    const snapshot = await prepareSessionBindingInspections(refs);
    releases.push(snapshot.dispose);
    return () => snapshot.inspect();
  };
  try {
    const groups = new Map<
      NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwnersAsync"]>,
      number[]
    >();
    const resolvers = new Map<number, PluginRouteOwnerResolver>();
    const plugins = inputs.map((input, index) => {
      const channel = normalizeChannelId(input.conversation.channel);
      const plugin = channel ? getLoadedChannelPlugin(channel) : undefined;
      const prepare = plugin?.messaging?.prepareConversationRouteOwnersAsync;
      if (prepare) {
        const group = groups.get(prepare) ?? [];
        group.push(index);
        groups.set(prepare, group);
      }
      return { channel, plugin };
    });
    for (const [index, input] of inputs.entries()) {
      const messaging = plugins[index]?.plugin?.messaging;
      if (
        messaging?.prepareConversationRouteOwners &&
        !messaging.prepareConversationRouteOwnersAsync
      ) {
        warnPluginSdkDeprecation({
          family: "conversation-route-ownership",
          method: "ChannelMessagingAdapter.prepareConversationRouteOwners",
          replacement: "ChannelMessagingAdapter.prepareConversationRouteOwnersAsync",
        });
        let preparing = true;
        try {
          const [resolver] = messaging.prepareConversationRouteOwners(
            [pluginRouteOwnerInput(params.config, input.conversation)],
            (refs) => {
              if (!preparing) throw new Error("Conversation route preparation is no longer active");
              return inspectSessionBindingsByConversations(refs);
            },
          );
          if (resolver) resolvers.set(index, resolver);
        } finally {
          preparing = false;
        }
      }
    }
    for (const [prepare, indexes] of groups) {
      let preparing = true;
      let selected: readonly PluginRouteOwnerResolver[];
      try {
        selected = await prepare(
          indexes.map((index) => pluginRouteOwnerInput(params.config, inputs[index]!.conversation)),
          (refs) => {
            if (!preparing) throw new Error("Conversation route preparation is no longer active");
            return inspectBindings(refs);
          },
        );
      } finally {
        preparing = false;
      }
      if (selected.length !== indexes.length)
        throw new Error("Plugin route owner returned an incomplete selection");
      indexes.forEach((index, position) => resolvers.set(index, selected[position]!));
    }
    const prepared = inputs.map((input, index) => {
      const resolver = resolvers.get(index);
      const owner = resolvePluginRouteOwner(input.config, input.conversation, resolver);
      if (owner) return { kind: "plugin" as const, resolver };
      const route = resolveConfiguredRouteOwner(
        input.config,
        input.conversation,
        input.conversation.routeContext,
      );
      return route
        ? {
            kind: "binding" as const,
            ...prepareGenericRoute({ ...input, route, context: input.conversation.routeContext }),
          }
        : { kind: "denied" as const };
    });
    const inspect = await inspectBindings(
      prepared.flatMap((entry) => (entry.kind === "binding" ? [entry.conversation] : [])),
    );
    return {
      read(): ConversationRouteEligibility[] {
        for (const { channel, plugin } of plugins) {
          if (channel && getLoadedChannelPlugin(channel) !== plugin)
            throw new Error("Conversation route owner changed. Retry the request.");
        }
        const inspections = inspect();
        let position = 0;
        return prepared.map((entry, index) => {
          if (entry.kind === "denied") return "denied";
          const input = inputs[index]!;
          const owner =
            entry.kind === "plugin"
              ? resolvePluginRouteOwner(input.config, input.conversation, entry.resolver)
              : resolveInspectedGenericRouteOwner(entry.route, inspections[position++]!);
          return owner ? finishRouteEligibility(input, owner) : "unavailable";
        });
      },
      dispose() {
        for (const release of releases) release();
      },
    };
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
}

export async function resolveConversationRouteEligibilitiesForAgent(
  params: Parameters<typeof prepareConversationRouteEligibilitiesForAgent>[0],
) {
  const prepared = await prepareConversationRouteEligibilitiesForAgent(params);
  try {
    return prepared.read();
  } finally {
    prepared.dispose();
  }
}

function assertConversationDeliveryRouteAuthorized(
  params: {
    config: OpenClawConfig;
    agentId: string;
    conversation: ConversationRecord | undefined;
  } & ConversationAuthority,
  eligibility: ConversationRouteEligibility,
): void {
  const conversation = params.conversation;
  try {
    assertConversationAuthority(conversation, params);
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      `Conversation is no longer available to this agent: ${params.conversationRef}`,
      { cause, retryable: false },
    );
  }
  if (eligibility === "eligible") {
    return;
  }
  throw new PlatformMessageNotDispatchedError(
    eligibility === "unavailable"
      ? `Conversation ownership is temporarily unavailable: ${params.conversationRef}`
      : `Conversation is no longer available to this agent: ${params.conversationRef}`,
    { cause: undefined, retryable: eligibility === "unavailable" },
  );
}

export async function prepareConversationDeliveryRouteAuthorization(
  params: {
    config: OpenClawConfig;
    readCurrentConfig?: () => OpenClawConfig;
    agentId: string;
    conversation: ConversationRecord;
  } & ConversationAuthority,
) {
  const prepared = await prepareConversationRouteEligibilitiesForAgent({
    ...params,
    conversations: [params.conversation],
  });
  return {
    assertCurrent(
      conversation: ConversationRecord | undefined,
      authority: ConversationAuthority = params,
    ) {
      const config = params.readCurrentConfig?.() ?? params.config;
      if (config !== params.config)
        throw new PlatformMessageNotDispatchedError(
          "Conversation routing configuration changed. Retry the request.",
          { cause: undefined, retryable: true },
        );
      assertConversationDeliveryRouteAuthorized(
        { ...params, ...authority, conversation, config },
        prepared.read()[0]!,
      );
    },
    dispose: prepared.dispose,
  };
}

export async function withAuthorizedConversationDelivery<T>(
  params: {
    config: OpenClawConfig;
    readCurrentConfig?: () => OpenClawConfig;
    agentId: string;
    scope: ConversationRegistryScope;
    routeAuthority?: Awaited<ReturnType<typeof prepareConversationDeliveryRouteAuthorization>>;
  } & ConversationAuthority,
  initiate: () => Promise<T>,
): Promise<T> {
  const conversation = params.routeAuthority
    ? undefined
    : await readConversation(params.scope, params.conversationRef);
  if (!params.routeAuthority && !conversation)
    throw new PlatformMessageNotDispatchedError("Conversation is no longer available", {
      cause: undefined,
      retryable: false,
    });
  const routeAuthority =
    params.routeAuthority ??
    (await prepareConversationDeliveryRouteAuthorization({
      ...params,
      conversation: conversation!,
    }));
  try {
    return await withConversationAuthority(
      params.scope,
      { conversationRef: params.conversationRef },
      ({ conversation }) => {
        routeAuthority.assertCurrent(conversation, params);
        return initiate;
      },
    );
  } finally {
    if (!params.routeAuthority) routeAuthority.dispose();
  }
}

export async function withAuthorizedQueuedConversationDelivery<T>(
  params: {
    readCurrentConfig: () => OpenClawConfig;
    operationId: string;
    routeFingerprint: string;
  },
  capturedScope: ConversationRegistryScope,
  initiate: () => Promise<T>,
): Promise<T> {
  const operation = await getConversationDeliveryOperation(capturedScope, params.operationId);
  if (!operation)
    throw new PlatformMessageNotDispatchedError(
      `Conversation delivery operation no longer exists: ${params.operationId}`,
      { cause: undefined, retryable: false },
    );
  const conversation = await readConversation(capturedScope, operation.conversationRef);
  if (!conversation)
    throw new PlatformMessageNotDispatchedError("Conversation is no longer available", {
      cause: undefined,
      retryable: false,
    });
  const authority = {
    conversationRef: operation.conversationRef,
    expectedRouteFingerprint: params.routeFingerprint,
  };
  const routeAuthority = await prepareConversationDeliveryRouteAuthorization({
    ...authority,
    config: params.readCurrentConfig(),
    readCurrentConfig: params.readCurrentConfig,
    agentId: capturedScope.agentId,
    conversation,
  });
  try {
    return await withConversationAuthority(
      capturedScope,
      { operationId: params.operationId },
      ({ operation, conversation }) => {
        if (!operation || operation.conversationRef !== authority.conversationRef)
          throw new PlatformMessageNotDispatchedError(
            `Conversation delivery operation no longer exists: ${params.operationId}`,
            { cause: undefined, retryable: false },
          );
        routeAuthority.assertCurrent(conversation, authority);
        return initiate;
      },
    );
  } finally {
    routeAuthority.dispose();
  }
}
