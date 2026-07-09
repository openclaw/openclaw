/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { normalizeOptionalAccountId, normalizeAccountId } from "../../routing/account-id.js";
import { normalizeConversationReadInvocationOrigin } from "./conversation-read-origin.js";
import { resolveChannelPluginRegistration } from "./registry.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "./types.js";

const READ_DEPENDENT_ACTIONS = new Set<ChannelMessageActionName>([
  "poll-vote",
  "react",
  "reactions",
  "read",
  "edit",
  "unsend",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "permissions",
  "thread-list",
  "search",
  "sticker-search",
  "member-info",
  "role-info",
  "emoji-list",
  "channel-info",
  "channel-list",
  "voice-status",
  "event-list",
  "download-file",
]);

// These bundled adapters have host-reviewed provider-side current/configured
// gates. Other bundled adapters retain the exact-current compatibility limit.
const BUNDLED_CHANNELS_WITH_PROVIDER_READ_GATES = new Set([
  "discord",
  "feishu",
  "matrix",
  "msteams",
  "slack",
]);

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

function normalizeHostConversationTarget(params: {
  value: unknown;
  channel: string;
  impliedKind?: HostConversationTargetKind;
}): HostConversationTarget | undefined {
  if (typeof params.value !== "string") {
    return undefined;
  }
  const value = params.value.trim();
  if (!value) {
    return undefined;
  }
  const providerPrefixPattern = new RegExp(
    `^${params.channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`,
    "i",
  );
  const withoutProvider = value.replace(providerPrefixPattern, "").trim();
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
  requestedTarget: HostConversationTarget;
}): boolean {
  const sameId = params.currentTargets.filter(
    (currentTarget) => currentTarget.id === params.requestedTarget.id,
  );
  if (sameId.length === 0 || !params.requestedTarget.kind) {
    return sameId.length > 0;
  }
  const typedCurrentTargets = sameId.filter((currentTarget) => currentTarget.kind);
  if (typedCurrentTargets.length === 0) {
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

function isExactCurrentConversation(params: { ctx: ChannelMessageActionContext }): boolean {
  if (
    !hasMatchingCurrentProviderContext(params.ctx) ||
    !hasMatchingCurrentAccountContext(params.ctx)
  ) {
    return false;
  }
  const requestedTargets = new Map<string, HostConversationTarget>();
  for (const [key, impliedKind] of [
    ["target", undefined],
    ["to", undefined],
    ["channelId", "channel"],
    ["roomId", "room"],
    ["chatId", "chat"],
  ] as const) {
    addHostConversationTarget(
      requestedTargets,
      normalizeHostConversationTarget({
        value: params.ctx.params[key],
        channel: params.ctx.channel,
        impliedKind,
      }),
    );
  }
  const requestedTargetList = Array.from(requestedTargets.values());
  if (requestedTargetList.length === 0 || hasConflictingTargetKinds(requestedTargetList)) {
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
      }),
    );
  }
  const currentTargetList = Array.from(currentTargets.values());
  if (hasConflictingTargetKinds(currentTargetList)) {
    return false;
  }
  return requestedTargetList.every((requestedTarget) =>
    currentTargetsMatchRequested({
      currentTargets: currentTargetList,
      requestedTarget,
    }),
  );
}

function assertConversationReadAllowed(params: {
  ctx: ChannelMessageActionContext;
  pluginOrigin: string | undefined;
}): void {
  const usesBundledProviderReadGate =
    params.pluginOrigin === "bundled" &&
    BUNDLED_CHANNELS_WITH_PROVIDER_READ_GATES.has(params.ctx.channel);
  if (
    normalizeConversationReadInvocationOrigin(params.ctx.conversationReadOrigin) ===
      "direct-operator" ||
    usesBundledProviderReadGate ||
    !READ_DEPENDENT_ACTIONS.has(params.ctx.action)
  ) {
    return;
  }
  if (isExactCurrentConversation({ ctx: params.ctx })) {
    return;
  }
  throw new Error(
    `Delegated ${params.ctx.channel}:${params.ctx.action} requires the exact current conversation and account for this plugin.`,
  );
}

function requiresTrustedRequesterSender(
  ctx: ChannelMessageActionContext,
  plugin: ChannelPlugin,
): boolean {
  return Boolean(
    plugin?.actions?.requiresTrustedRequesterSender?.({
      action: ctx.action,
      toolContext: ctx.toolContext,
    }),
  );
}

/**
 * Runs a channel message action if the target plugin supports it.
 */
export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  const registration = resolveChannelPluginRegistration(ctx.channel);
  if (!registration) {
    return null;
  }
  const { plugin } = registration;
  const actions = plugin.actions;
  if (!actions?.handleAction) {
    return null;
  }
  // Loader provenance is host-owned. External and legacy registrations must
  // prove the exact current conversation before any plugin callback can run.
  assertConversationReadAllowed({
    ctx,
    pluginOrigin: registration.origin,
  });
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the action without it.
  if (requiresTrustedRequesterSender(ctx, plugin) && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (actions.supportsAction && !actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await actions.handleAction(ctx);
}
