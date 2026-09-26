import { normalizeOptionalAccountId, normalizeAccountId } from "../../routing/account-id.js";
import { normalizeChatType, type ChatType } from "../chat-type.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.js";

const HOST_TARGET_KIND_PREFIXES = [
  "user",
  "channel",
  "room",
  "chat",
  "group",
  "dm",
  "conversation",
] as const;

type HostConversationTargetKind = (typeof HOST_TARGET_KIND_PREFIXES)[number];

type HostConversationTarget = {
  id: string;
  kind?: HostConversationTargetKind;
};

function isHostConversationTargetKind(value: string): value is HostConversationTargetKind {
  return HOST_TARGET_KIND_PREFIXES.some((kind) => kind === value);
}

function stripHostProviderPrefix(params: {
  value: string;
  channel: string;
  providerPrefixes?: readonly string[];
}): string {
  const prefixes = [params.channel, ...(params.providerPrefixes ?? [])]
    .map((prefix) => prefix.trim().toLowerCase())
    .filter((prefix) => Boolean(prefix) && !isHostConversationTargetKind(prefix));
  const lowered = params.value.toLowerCase();
  const prefix = prefixes.find((candidate) => lowered.startsWith(`${candidate}:`));
  return prefix ? params.value.slice(prefix.length + 1).trim() : params.value;
}

export function normalizeHostConversationTarget(params: {
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
    const kind = typedTarget[1]?.toLowerCase();
    if (!id || !kind || !isHostConversationTargetKind(kind)) {
      return undefined;
    }
    return {
      id,
      kind,
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
  const kindsById = new Map<string, HostConversationTargetKind>();
  for (const target of targets) {
    if (!target.kind) {
      continue;
    }
    const kind = kindsById.get(target.id);
    if (kind && kind !== target.kind) {
      return true;
    }
    kindsById.set(target.id, target.kind);
  }
  return false;
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

export function hasMatchingCurrentAccountContext(ctx: ChannelMessageActionContext): boolean {
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

export function hasMatchingCurrentProviderContext(ctx: ChannelMessageActionContext): boolean {
  const currentProvider = ctx.toolContext?.currentChannelProvider?.trim().toLowerCase();
  return Boolean(currentProvider && currentProvider === ctx.channel.trim().toLowerCase());
}

export function hasCurrentConversationTarget(ctx: ChannelMessageActionContext): boolean {
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

export type CurrentConversationMatch = boolean | (() => Promise<boolean>);

export function resolveExactCurrentConversationMatch(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  pluginTrust: "bundled" | "external";
}): CurrentConversationMatch {
  if (
    !hasMatchingCurrentProviderContext(params.ctx) ||
    !hasMatchingCurrentAccountContext(params.ctx)
  ) {
    return false;
  }
  const normalizeTarget =
    params.pluginTrust === "bundled" ? params.plugin.messaging?.normalizeTarget : undefined;
  const providerPrefixes = params.plugin.messaging?.targetPrefixes;
  const normalize = (value: unknown, impliedKind?: HostConversationTargetKind) =>
    normalizeHostConversationTarget({
      value,
      channel: params.ctx.channel,
      impliedKind,
      normalizeTarget,
      providerPrefixes,
    });
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
    const normalizedTarget = normalize(rawTarget, impliedKind);
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
    normalizedAliasTarget = normalize(resolvedAliasTarget);
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
    addHostConversationTarget(currentTargets, normalize(value));
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
    (!aliasSpec?.matchesCurrentConversationAsync && !aliasSpec?.matchesCurrentConversation) ||
    !nonAliasRequestedTargets.every(matchesCurrentTarget)
  ) {
    return false;
  }
  const matchParams = {
    args: params.ctx.params,
    accountId: normalizeAccountId(params.ctx.accountId),
    toolContext: params.ctx.toolContext,
  };
  const matchAsync = aliasSpec.matchesCurrentConversationAsync;
  if (matchAsync) {
    return () => matchAsync(matchParams);
  }
  return aliasSpec.matchesCurrentConversation?.(matchParams) === true;
}
