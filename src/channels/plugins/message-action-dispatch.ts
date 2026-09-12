/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { normalizeOptionalAccountId, normalizeAccountId } from "../../routing/account-id.js";
import { normalizeChatType, type ChatType } from "../chat-type.js";
import { normalizeConversationReadInvocationOrigin } from "./conversation-read-origin.js";
import {
  resolveChannelMessageActionReadPolicy,
  resolveMessageActionReadEnforcement,
  type ChannelMessageActionReadPolicy,
  type MessageActionReadEnforcement,
} from "./message-action-read-policy.js";
import { resolveChannelPluginRegistration } from "./registry.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "./types.js";

declare const serverOwnedConversationReadOrigin: unique symbol;

type ServerOwnedConversationReadOrigin = ReturnType<
  typeof normalizeConversationReadInvocationOrigin
> & {
  readonly [serverOwnedConversationReadOrigin]: true;
};

type ChannelMessageActionDispatchContext = Omit<ChannelMessageActionContext, "action"> & {
  action: unknown;
};

type PreparedMessageActionReadContext = {
  actionContext: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  origin: ServerOwnedConversationReadOrigin;
  actionPolicy: ChannelMessageActionReadPolicy;
  enforcement: MessageActionReadEnforcement;
  assertReadAuthorityCurrent?: () => void;
};

function resolveServerOwnedConversationReadOrigin(
  value: unknown,
): ServerOwnedConversationReadOrigin {
  return normalizeConversationReadInvocationOrigin(value) as ServerOwnedConversationReadOrigin;
}

type HostConversationTargetKind =
  | "user"
  | "channel"
  | "room"
  | "chat"
  | "group"
  | "dm"
  | "conversation";

type HostConversationTarget = {
  id: string;
  kind?: HostConversationTargetKind;
};

const HOST_TARGET_KIND_PREFIXES = new Set<HostConversationTargetKind>([
  "user",
  "channel",
  "room",
  "chat",
  "group",
  "dm",
  "conversation",
]);

function stripHostProviderPrefix(params: {
  value: string;
  channel: string;
  providerPrefixes?: readonly string[];
}): string {
  const prefixes = [params.channel, ...(params.providerPrefixes ?? [])]
    .map((prefix) => prefix.trim().toLowerCase())
    .filter(
      (prefix): prefix is string =>
        Boolean(prefix) && !HOST_TARGET_KIND_PREFIXES.has(prefix as HostConversationTargetKind),
    );
  const lowered = params.value.toLowerCase();
  const prefix = prefixes.find((candidate) => lowered.startsWith(`${candidate}:`));
  return prefix ? params.value.slice(prefix.length + 1).trim() : params.value;
}

function normalizeHostConversationTarget(params: {
  value: unknown;
  channel: string;
  impliedKind?: HostConversationTargetKind;
  normalizeTarget?: (raw: string) => string | undefined;
  providerPrefixes?: readonly string[];
}): HostConversationTarget | undefined {
  if (typeof params.value !== "string") {
    return undefined;
  }
  const rawValue = params.value.trim();
  const value = params.normalizeTarget ? params.normalizeTarget(rawValue)?.trim() : rawValue;
  if (!value) {
    return undefined;
  }
  const withoutProvider = stripHostProviderPrefix({
    value,
    channel: params.channel,
    providerPrefixes: params.providerPrefixes,
  });
  if (!withoutProvider) {
    return undefined;
  }
  const typedTarget = withoutProvider.match(
    /^(user|channel|room|chat|group|dm|conversation):(.*)$/i,
  );
  if (typedTarget) {
    const id = typedTarget[2]?.trim();
    if (!id) {
      return undefined;
    }
    return {
      id,
      kind: typedTarget[1]?.toLowerCase() as HostConversationTargetKind,
    };
  }
  return {
    id: withoutProvider,
    ...(params.impliedKind ? { kind: params.impliedKind } : {}),
  };
}

function targetKey(target: HostConversationTarget): string {
  return `${target.kind ?? ""}\0${target.id}`;
}

function addHostConversationTarget(
  targets: Map<string, HostConversationTarget>,
  target: HostConversationTarget | undefined,
): void {
  if (target) {
    targets.set(targetKey(target), target);
  }
}

function hasConflictingTargetKinds(targets: HostConversationTarget[]): boolean {
  const kindsById = new Map<string, Set<HostConversationTargetKind>>();
  for (const target of targets) {
    if (!target.kind) {
      continue;
    }
    const kinds = kindsById.get(target.id) ?? new Set<HostConversationTargetKind>();
    kinds.add(target.kind);
    kindsById.set(target.id, kinds);
  }
  return Array.from(kindsById.values()).some((kinds) => kinds.size > 1);
}

function currentTargetsMatchRequested(params: {
  currentTargets: HostConversationTarget[];
  requestedTargets: HostConversationTarget[];
  requestedTarget: HostConversationTarget;
  currentChatType?: ChatType;
}): boolean {
  const sameId = params.currentTargets.filter(
    (currentTarget) => currentTarget.id === params.requestedTarget.id,
  );
  if (sameId.length === 0 || !params.requestedTarget.kind) {
    return sameId.length > 0;
  }
  const typedCurrentTargets = sameId.filter((currentTarget) => currentTarget.kind);
  if (typedCurrentTargets.length === 0) {
    const hasCanonicalSibling = params.requestedTargets.some(
      (requestedTarget) =>
        requestedTarget.id === params.requestedTarget.id && !requestedTarget.kind,
    );
    if (!hasCanonicalSibling) {
      return false;
    }
    if (params.currentChatType === "direct") {
      return params.requestedTarget.kind === "user" || params.requestedTarget.kind === "dm";
    }
    if (params.currentChatType === "group") {
      return params.requestedTarget.kind === "group" || params.requestedTarget.kind === "room";
    }
    if (params.currentChatType === "channel") {
      return params.requestedTarget.kind === "channel";
    }
    return false;
  }
  return typedCurrentTargets.some(
    (currentTarget) => currentTarget.kind === params.requestedTarget.kind,
  );
}

function hasMatchingCurrentAccountContext(ctx: ChannelMessageActionContext): boolean {
  const rawAccountId = ctx.accountId?.trim() ?? "";
  const rawRequesterAccountId = ctx.requesterAccountId?.trim() ?? "";
  if (!rawRequesterAccountId) {
    return false;
  }
  if (
    (rawAccountId && !normalizeOptionalAccountId(rawAccountId)) ||
    !normalizeOptionalAccountId(rawRequesterAccountId)
  ) {
    return false;
  }
  return normalizeAccountId(rawAccountId) === normalizeAccountId(rawRequesterAccountId);
}

function hasMatchingCurrentProviderContext(ctx: ChannelMessageActionContext): boolean {
  const currentProvider = ctx.toolContext?.currentChannelProvider?.trim().toLowerCase();
  return Boolean(currentProvider && currentProvider === ctx.channel.trim().toLowerCase());
}

function hasCurrentConversationTarget(ctx: ChannelMessageActionContext): boolean {
  return [ctx.toolContext?.currentChannelId, ctx.toolContext?.currentMessagingTarget].some(
    (value) => typeof value === "string" && Boolean(value.trim()),
  );
}

function hasTargetInput(value: unknown): boolean {
  if (typeof value === "string") {
    return Boolean(value.trim());
  }
  return typeof value === "number" && Number.isFinite(value);
}

function attachExternalCurrentTargetSibling(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  origin: ServerOwnedConversationReadOrigin;
  actionPolicy: ChannelMessageActionReadPolicy;
  enforcement: MessageActionReadEnforcement;
}): ChannelMessageActionContext {
  if (
    params.origin === "direct-operator" ||
    params.actionPolicy.kind !== "conversation-read" ||
    params.enforcement.kind !== "host-exact-current" ||
    params.enforcement.pluginTrust !== "external"
  ) {
    return params.ctx;
  }
  const target =
    typeof params.ctx.params.target === "string" ? params.ctx.params.target.trim() : "";
  if (!target) {
    return params.ctx;
  }
  const mirroredTo = params.ctx.params.to;
  if (typeof mirroredTo !== "string" || mirroredTo.trim() !== target) {
    return params.ctx;
  }
  const providerPrefixes = params.plugin.messaging?.targetPrefixes;
  const requestedTarget = normalizeHostConversationTarget({
    value: target,
    channel: params.ctx.channel,
    providerPrefixes,
  });
  if (!requestedTarget) {
    return params.ctx;
  }
  const trustedCurrentTarget = [
    params.ctx.toolContext?.currentMessagingTarget,
    params.ctx.toolContext?.currentChannelId,
  ].find((value) => {
    const normalized = normalizeHostConversationTarget({
      value,
      channel: params.ctx.channel,
      providerPrefixes,
    });
    return (
      normalized?.id === requestedTarget.id &&
      (!requestedTarget.kind || !normalized.kind || normalized.kind === requestedTarget.kind)
    );
  });
  if (typeof trustedCurrentTarget !== "string" || !trustedCurrentTarget.trim()) {
    return params.ctx;
  }
  return {
    ...params.ctx,
    params: {
      ...params.ctx.params,
      to: trustedCurrentTarget.trim(),
    },
  };
}

function isExactCurrentConversation(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  pluginTrust: "bundled" | "external";
}): boolean {
  if (
    !hasMatchingCurrentProviderContext(params.ctx) ||
    !hasMatchingCurrentAccountContext(params.ctx)
  ) {
    return false;
  }
  const normalizeTarget =
    params.pluginTrust === "bundled" ? params.plugin.messaging?.normalizeTarget : undefined;
  const providerPrefixes = params.plugin.messaging?.targetPrefixes;
  const aliasSpec =
    params.pluginTrust === "bundled"
      ? params.plugin.actions?.messageActionTargetAliases?.[params.ctx.action]
      : undefined;
  const deliveryTargetAliases = new Set(aliasSpec?.deliveryTargetAliases ?? []);
  const requestedTargets = new Map<string, HostConversationTarget>();
  for (const [key, impliedKind] of [
    ["target", undefined],
    ["to", undefined],
    ["channelId", "channel"],
    ["roomId", "room"],
    ["chatId", "chat"],
  ] as const) {
    const rawTarget = params.ctx.params[key];
    if (deliveryTargetAliases.has(key)) {
      continue;
    }
    const normalizedTarget = normalizeHostConversationTarget({
      value: rawTarget,
      channel: params.ctx.channel,
      impliedKind,
      normalizeTarget,
      providerPrefixes,
    });
    if (hasTargetInput(rawTarget) && !normalizedTarget) {
      return false;
    }
    addHostConversationTarget(requestedTargets, normalizedTarget);
  }
  let hasDeliveryAliasInput = false;
  let normalizedAliasTarget: HostConversationTarget | undefined;
  if (params.pluginTrust === "bundled") {
    hasDeliveryAliasInput = (aliasSpec?.deliveryTargetAliases ?? []).some((alias) =>
      hasTargetInput(params.ctx.params[alias]),
    );
    const resolvedAliasTarget = aliasSpec?.resolveDeliveryTarget?.({ args: params.ctx.params });
    normalizedAliasTarget = normalizeHostConversationTarget({
      value: resolvedAliasTarget,
      channel: params.ctx.channel,
      normalizeTarget,
      providerPrefixes,
    });
    if (
      (hasDeliveryAliasInput && !resolvedAliasTarget) ||
      (resolvedAliasTarget !== undefined && !normalizedAliasTarget)
    ) {
      return false;
    }
    addHostConversationTarget(requestedTargets, normalizedAliasTarget);
  }
  const normalizedAliasTargetKey = normalizedAliasTarget
    ? targetKey(normalizedAliasTarget)
    : undefined;
  // Normalization mirrors a delivery alias into target/to. Treat that exact
  // canonical value as the alias itself; distinct sibling targets still block.
  const nonAliasRequestedTargets = Array.from(requestedTargets.values()).filter(
    (target) => targetKey(target) !== normalizedAliasTargetKey,
  );
  const requestedTargetList = Array.from(requestedTargets.values());
  if (hasConflictingTargetKinds(requestedTargetList)) {
    return false;
  }
  const currentTargets = new Map<string, HostConversationTarget>();
  for (const value of [
    params.ctx.toolContext?.currentChannelId,
    params.ctx.toolContext?.currentMessagingTarget,
  ]) {
    addHostConversationTarget(
      currentTargets,
      normalizeHostConversationTarget({
        value,
        channel: params.ctx.channel,
        normalizeTarget,
        providerPrefixes,
      }),
    );
  }
  const currentTargetList = Array.from(currentTargets.values());
  if (currentTargetList.length === 0 || hasConflictingTargetKinds(currentTargetList)) {
    return false;
  }
  if (requestedTargetList.length === 0) {
    return false;
  }
  const currentChatType = normalizeChatType(params.ctx.toolContext?.currentChatType);
  const matchesCurrentTarget = (requestedTarget: HostConversationTarget) =>
    currentTargetsMatchRequested({
      currentTargets: currentTargetList,
      requestedTargets: requestedTargetList,
      requestedTarget,
      currentChatType,
    });
  if (requestedTargetList.every(matchesCurrentTarget)) {
    return true;
  }
  if (
    params.pluginTrust !== "bundled" ||
    !hasDeliveryAliasInput ||
    !params.ctx.toolContext ||
    !aliasSpec?.matchesCurrentConversation ||
    !nonAliasRequestedTargets.every(matchesCurrentTarget)
  ) {
    return false;
  }
  return aliasSpec.matchesCurrentConversation({
    args: params.ctx.params,
    accountId: normalizeAccountId(params.ctx.accountId),
    toolContext: params.ctx.toolContext,
  });
}

function canonicalizeExternalExactCurrentTarget(ctx: ChannelMessageActionContext): void {
  const target = ctx.params.target;
  const resolvedTarget = [ctx.params.to, ctx.params.channelId].find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
  if (typeof target === "string" && target.trim() && resolvedTarget) {
    // Authorization used the raw spelling. Plugin execution receives the
    // resolved destination so it cannot reinterpret an accepted kind alias.
    ctx.params.target = resolvedTarget;
  }
}

function prepareMessageActionReadContext(
  ctx: ChannelMessageActionDispatchContext,
): PreparedMessageActionReadContext | undefined {
  const actionPolicy = resolveChannelMessageActionReadPolicy(ctx.action);
  if (!actionPolicy) {
    return undefined;
  }
  const registration = resolveChannelPluginRegistration(ctx.channel);
  if (!registration) {
    return undefined;
  }
  const action = ctx.action as ChannelMessageActionName;
  const origin = resolveServerOwnedConversationReadOrigin(ctx.conversationReadOrigin);
  const actionContext: ChannelMessageActionContext = {
    ...ctx,
    action,
    conversationReadOrigin: origin,
  };
  const enforcement = resolveMessageActionReadEnforcement({
    action,
    actions: registration.plugin.actions,
    pluginOrigin: registration.origin,
    pluginTrustedOfficialInstall: registration.trustedOfficialInstall,
  });
  let assertReadAuthorityCurrent: (() => void) | undefined;
  if (
    actionPolicy.kind === "conversation-read" &&
    enforcement.kind === "provider-owned" &&
    registration.origin !== "bundled"
  ) {
    const isCurrent = registration.captureReadAuthority?.();
    assertReadAuthorityCurrent = () => {
      if (!isCurrent?.()) {
        throw new Error(`Plugin ${ctx.channel} read authority is no longer active.`);
      }
    };
    assertReadAuthorityCurrent();
  }
  return {
    actionContext,
    plugin: registration.plugin,
    origin,
    actionPolicy,
    enforcement,
    assertReadAuthorityCurrent,
  };
}

function isExternalDelegatedMessageActionRead(
  prepared: PreparedMessageActionReadContext | undefined,
): prepared is PreparedMessageActionReadContext & {
  actionPolicy: Extract<ChannelMessageActionReadPolicy, { kind: "conversation-read" }>;
  enforcement: Extract<MessageActionReadEnforcement, { kind: "host-exact-current" }> & {
    pluginTrust: "external";
  };
} {
  return Boolean(
    prepared &&
    prepared.origin !== "direct-operator" &&
    prepared.actionPolicy.kind === "conversation-read" &&
    prepared.enforcement.kind === "host-exact-current" &&
    prepared.enforcement.pluginTrust === "external",
  );
}

/** The sole host chokepoint before any read-capable plugin callback runs. */
function enforceMessageActionConversationReadGate(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  origin: ServerOwnedConversationReadOrigin;
  actionPolicy: ChannelMessageActionReadPolicy;
  enforcement: MessageActionReadEnforcement;
}): void {
  if (params.actionPolicy.kind === "none" || params.origin === "direct-operator") {
    return;
  }
  if (params.enforcement.kind === "provider-owned") {
    return;
  }

  const isBundledCurrentContextCacheRead =
    params.enforcement.pluginTrust === "bundled" &&
    params.actionPolicy.targetlessCache === "bundled-current-context" &&
    hasMatchingCurrentProviderContext(params.ctx) &&
    hasMatchingCurrentAccountContext(params.ctx) &&
    hasCurrentConversationTarget(params.ctx);
  const exactCurrentConversation =
    isBundledCurrentContextCacheRead ||
    isExactCurrentConversation({
      ctx: params.ctx,
      plugin: params.plugin,
      pluginTrust: params.enforcement.pluginTrust,
    });
  if (!exactCurrentConversation) {
    throw new Error(
      `Delegated ${params.ctx.channel}:${params.ctx.action} requires the exact current conversation and account for this plugin.`,
    );
  }
  if (params.enforcement.pluginTrust === "external") {
    canonicalizeExternalExactCurrentTarget(params.ctx);
  }
}

/** Authorizes and canonicalizes external exact-current targets before target resolution. */
export function prepareExternalMessageActionTargetForResolution(
  ctx: ChannelMessageActionDispatchContext,
): Record<string, unknown> {
  const prepared = prepareMessageActionReadContext(ctx);
  if (!isExternalDelegatedMessageActionRead(prepared)) {
    return ctx.params;
  }
  // External target resolution can execute plugin directory/provider lookups.
  // Establish exact-current authority before that boundary, then recheck at dispatch.
  const authorizedActionContext = attachExternalCurrentTargetSibling({
    ctx: prepared.actionContext,
    plugin: prepared.plugin,
    origin: prepared.origin,
    actionPolicy: prepared.actionPolicy,
    enforcement: prepared.enforcement,
  });
  enforceMessageActionConversationReadGate({
    ctx: authorizedActionContext,
    plugin: prepared.plugin,
    origin: prepared.origin,
    actionPolicy: prepared.actionPolicy,
    enforcement: prepared.enforcement,
  });
  return authorizedActionContext.params;
}

/** Keeps official read lookups within V2; external delegated lookups wait for the Gateway. */
export function shouldDeferExternalMessageActionTargetResolution(
  ctx: ChannelMessageActionDispatchContext,
  delegatesToGateway = true,
): boolean {
  const prepared = prepareMessageActionReadContext(ctx);
  return Boolean(
    prepared?.assertReadAuthorityCurrent ||
    (delegatesToGateway && isExternalDelegatedMessageActionRead(prepared)),
  );
}

/**
 * Runs a channel message action if the target plugin supports it.
 */
export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionDispatchContext,
): Promise<AgentToolResult<unknown> | null> {
  const prepared = prepareMessageActionReadContext(ctx);
  if (!prepared) {
    return null;
  }
  const { actionContext, plugin, origin, actionPolicy, enforcement } = prepared;
  const actions = plugin.actions;
  if (!actions || (!prepared.assertReadAuthorityCurrent && !actions.handleAction)) {
    return null;
  }
  const authorizedActionContext = attachExternalCurrentTargetSibling({
    ctx: actionContext,
    plugin,
    origin,
    actionPolicy,
    enforcement,
  });
  enforceMessageActionConversationReadGate({
    ctx: authorizedActionContext,
    plugin,
    origin,
    actionPolicy,
    enforcement,
  });
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the action without it.
  if (
    actions.requiresTrustedRequesterSender?.({
      action: authorizedActionContext.action,
      toolContext: authorizedActionContext.toolContext,
    }) &&
    !authorizedActionContext.requesterSenderId?.trim()
  ) {
    throw new Error(
      `Trusted sender identity is required for ${authorizedActionContext.channel}:${authorizedActionContext.action} in tool-driven contexts.`,
    );
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (
    actions.supportsAction &&
    !actions.supportsAction({ action: authorizedActionContext.action })
  ) {
    return null;
  }
  prepared.assertReadAuthorityCurrent?.();
  try {
    if (prepared.assertReadAuthorityCurrent) {
      if (actions.conversationReadAuthority?.version !== 2) {
        throw new Error("Versioned conversation read authority adapter is required.");
      }
      return await actions.conversationReadAuthority.handleAction({
        ...authorizedActionContext,
        // Never accept an assertion supplied by the caller or tool arguments.
        assertConversationReadAuthority: prepared.assertReadAuthorityCurrent,
        prepareConversationReadTarget: async () => {
          const { prepareConversationReadTarget } =
            await import("../../infra/outbound/message-action-target-resolution.js");
          await prepareConversationReadTarget(
            authorizedActionContext,
            plugin,
            prepared.assertReadAuthorityCurrent!,
          );
        },
      });
    }
    return actions.handleAction
      ? await actions.handleAction({
          ...authorizedActionContext,
          assertConversationReadAuthority: undefined,
        })
      : null;
  } finally {
    // A replaced/disabled owner cannot publish late read data, including provider errors.
    prepared.assertReadAuthorityCurrent?.();
  }
}
