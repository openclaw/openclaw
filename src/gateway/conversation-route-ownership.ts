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
import {
  withConversationAuthority,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import type { ConversationRouteContext } from "../config/sessions/conversation-route-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import {
  inspectSessionBindingByConversation,
  inspectSessionBindingsByConversations,
} from "../infra/outbound/session-binding-service.js";
import { getGlobalPluginRegistry } from "../plugins/hook-runner-global.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingId } from "../routing/binding-scope.js";
import { peerKindMatches } from "../routing/peer-kind-match.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { ConversationInputError } from "./conversation-errors.js";

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

function prepareRouteEligibility(
  params: RouteEligibilityInput,
  preparedResolver?: PluginRouteOwnerResolver,
) {
  const owner = resolvePluginRouteOwner(params.config, params.conversation, preparedResolver);
  if (owner) {
    return { kind: "resolved" as const, eligibility: finishRouteEligibility(params, owner) };
  }
  const route = resolveConfiguredRouteOwner(
    params.config,
    params.conversation,
    params.conversation.routeContext,
  );
  if (!route) {
    return { kind: "resolved" as const, eligibility: "denied" as const };
  }
  return {
    kind: "binding" as const,
    ...prepareGenericRoute({ ...params, route, context: params.conversation.routeContext }),
  };
}

/** Replays current configured and plugin-owned routing for a persisted conversation address. */
function resolveConversationRouteEligibilityForAgent(
  params: RouteEligibilityInput,
): ConversationRouteEligibility {
  const prepared = prepareRouteEligibility(params);
  return prepared.kind === "resolved"
    ? prepared.eligibility
    : finishRouteEligibility(
        params,
        resolveInspectedGenericRouteOwner(
          prepared.route,
          inspectSessionBindingByConversation(prepared.conversation),
        ),
      );
}

/** Each grant obtains one current native selection; plugin resolvers retain precedence. */
export function resolveConversationRouteEligibilitiesForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversations: readonly ConversationRouteCandidate[];
}): ConversationRouteEligibility[] {
  const inputs = params.conversations.map((conversation) => ({
    config: params.config,
    agentId: params.agentId,
    conversation,
  }));
  const groups = new Map<
    NonNullable<ChannelMessagingAdapter["prepareConversationRouteOwners"]>,
    number[]
  >();
  for (const [index, input] of inputs.entries()) {
    const channel = normalizeChannelId(input.conversation.channel);
    const prepare = channel
      ? getLoadedChannelPlugin(channel)?.messaging?.prepareConversationRouteOwners
      : undefined;
    if (prepare) {
      const group = groups.get(prepare) ?? [];
      group.push(index);
      groups.set(prepare, group);
    }
  }
  const resolvers = new Map<number, PluginRouteOwnerResolver>();
  for (const [prepare, indexes] of groups) {
    let preparing = true;
    let selected: readonly PluginRouteOwnerResolver[];
    try {
      selected = prepare(
        indexes.map((index) => pluginRouteOwnerInput(params.config, inputs[index]!.conversation)),
        (refs) => {
          if (!preparing) {
            throw new Error("Conversation route preparation is no longer active");
          }
          return inspectSessionBindingsByConversations(refs);
        },
      );
    } finally {
      preparing = false;
    }
    if (selected.length !== indexes.length) {
      throw new Error("Plugin route owner returned an incomplete selection");
    }
    indexes.forEach((index, position) => {
      const resolver = selected[position];
      if (!resolver) {
        throw new Error("Plugin route owner returned an incomplete selection");
      }
      resolvers.set(index, resolver);
    });
  }
  const prepared = inputs.map((input, index) =>
    prepareRouteEligibility(input, resolvers.get(index)),
  );
  const inspections = inspectSessionBindingsByConversations(
    prepared.flatMap((entry) => (entry.kind === "binding" ? [entry.conversation] : [])),
  );
  let index = 0;
  return prepared.map((entry, position) =>
    entry.kind === "resolved"
      ? entry.eligibility
      : finishRouteEligibility(
          inputs[position]!,
          resolveInspectedGenericRouteOwner(entry.route, inspections[index++]!),
        ),
  );
}

/** Enforces current route ownership at a Gateway request boundary. */
export function assertConversationRouteEligibleForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate & Pick<ConversationRecord, "conversationRef">;
}): void {
  const eligibility = resolveConversationRouteEligibilityForAgent(params);
  if (eligibility === "eligible") {
    return;
  }
  if (eligibility === "denied") {
    throw new ConversationInputError(
      `Conversation is not available to this agent: ${params.conversation.conversationRef}`,
    );
  }
  throw new Error(
    `Conversation ownership is temporarily unavailable: ${params.conversation.conversationRef}`,
  );
}

export function assertConversationDeliveryRouteAuthorized(
  params: {
    config: OpenClawConfig;
    agentId: string;
    conversation: ConversationRecord | undefined;
  } & ConversationAuthority,
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
  const eligibility = resolveConversationRouteEligibilityForAgent({
    config: params.config,
    agentId: params.agentId,
    conversation,
  });
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

export function withAuthorizedConversationDelivery<T>(
  params: {
    config: OpenClawConfig;
    readCurrentConfig?: () => OpenClawConfig;
    agentId: string;
    scope: ConversationRegistryScope;
  } & ConversationAuthority,
  initiate: () => Promise<T>,
): Promise<T> {
  return withConversationAuthority(
    params.scope,
    { conversationRef: params.conversationRef },
    ({ conversation }) => {
      assertConversationDeliveryRouteAuthorized({
        ...params,
        conversation,
        config: params.readCurrentConfig?.() ?? params.config,
      });
      return initiate;
    },
  );
}

export function withAuthorizedQueuedConversationDelivery<T>(
  params: {
    readCurrentConfig: () => OpenClawConfig;
    operationId: string;
    routeFingerprint: string;
  },
  capturedScope: ConversationRegistryScope,
  initiate: () => Promise<T>,
): Promise<T> {
  return withConversationAuthority(
    capturedScope,
    { operationId: params.operationId },
    ({ operation, conversation }) => {
      if (!operation) {
        throw new PlatformMessageNotDispatchedError(
          `Conversation delivery operation no longer exists: ${params.operationId}`,
          { cause: undefined, retryable: false },
        );
      }
      assertConversationDeliveryRouteAuthorized({
        config: params.readCurrentConfig(),
        agentId: capturedScope.agentId,
        conversationRef: operation.conversationRef,
        expectedRouteFingerprint: params.routeFingerprint,
        conversation,
      });
      return initiate;
    },
  );
}
