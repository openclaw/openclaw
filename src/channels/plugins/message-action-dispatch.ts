/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import {
  prepareMessageActionWriteAuthority,
  withMessageActionWriteAuthority,
} from "../../infra/outbound/message-action-write-authority.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { withChannelReadAuthority } from "../../shared/channel-read-authority.js";
import { normalizeMessageChannel } from "../../utils/message-channel-normalize.js";
import { normalizeConversationReadInvocationOrigin } from "./conversation-read-origin.js";
import { resolveChannelDefaultAccountId } from "./helpers.js";
import {
  hasCurrentConversationTarget,
  hasMatchingCurrentAccountContext,
  hasMatchingCurrentProviderContext,
  normalizeHostConversationTarget,
  resolveExactCurrentConversationMatch,
  type CurrentConversationMatch,
} from "./message-action-current-conversation.js";
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
  /** Host-only authority, removed before invoking any plugin callback. */
  messageActionAuthorization?: MessageActionAuthorization;
};

type PreparedMessageActionReadContext = {
  actionContext: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  origin: ServerOwnedConversationReadOrigin;
  actionPolicy: ChannelMessageActionReadPolicy;
  enforcement: MessageActionReadEnforcement;
  scheduledAccess?: ScheduledMessageActionAccess;
  assertDashboardReadCurrent?: () => void;
  hasRegistrationAuthority: boolean;
  assertReadAuthorityCurrent?: () => void;
  assertAliasAuthorityCurrent: () => void;
};

type ChannelMessageActionReadPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "conversation-read";
      readonly targetlessCache: "deny" | "bundled-current-context";
    };

const NO_CONVERSATION_READ = { kind: "none" } as const;
const CONVERSATION_READ = { kind: "conversation-read", targetlessCache: "deny" } as const;
const BUNDLED_CURRENT_CONTEXT_CACHE_READ = {
  kind: "conversation-read",
  targetlessCache: "bundled-current-context",
} as const;

// Exhaustive by design: every new core action must declare its read authority
// before the dispatcher will compile.
const CHANNEL_MESSAGE_ACTION_READ_POLICIES = {
  send: NO_CONVERSATION_READ,
  broadcast: NO_CONVERSATION_READ,
  poll: NO_CONVERSATION_READ,
  "poll-vote": CONVERSATION_READ,
  react: CONVERSATION_READ,
  reactions: CONVERSATION_READ,
  read: CONVERSATION_READ,
  edit: CONVERSATION_READ,
  unsend: CONVERSATION_READ,
  reply: NO_CONVERSATION_READ,
  sendWithEffect: NO_CONVERSATION_READ,
  renameGroup: NO_CONVERSATION_READ,
  setGroupIcon: NO_CONVERSATION_READ,
  addParticipant: NO_CONVERSATION_READ,
  removeParticipant: NO_CONVERSATION_READ,
  leaveGroup: NO_CONVERSATION_READ,
  sendAttachment: NO_CONVERSATION_READ,
  delete: CONVERSATION_READ,
  pin: CONVERSATION_READ,
  unpin: CONVERSATION_READ,
  "list-pins": CONVERSATION_READ,
  permissions: CONVERSATION_READ,
  "thread-create": NO_CONVERSATION_READ,
  "thread-list": CONVERSATION_READ,
  "thread-reply": NO_CONVERSATION_READ,
  search: CONVERSATION_READ,
  sticker: NO_CONVERSATION_READ,
  "sticker-search": BUNDLED_CURRENT_CONTEXT_CACHE_READ,
  "member-info": CONVERSATION_READ,
  "role-info": CONVERSATION_READ,
  "emoji-list": CONVERSATION_READ,
  "emoji-upload": NO_CONVERSATION_READ,
  "sticker-upload": NO_CONVERSATION_READ,
  "role-add": NO_CONVERSATION_READ,
  "role-remove": NO_CONVERSATION_READ,
  "channel-info": CONVERSATION_READ,
  "channel-list": CONVERSATION_READ,
  "channel-create": NO_CONVERSATION_READ,
  "conversation-open": NO_CONVERSATION_READ,
  "channel-edit": NO_CONVERSATION_READ,
  "channel-delete": NO_CONVERSATION_READ,
  "channel-move": NO_CONVERSATION_READ,
  "category-create": NO_CONVERSATION_READ,
  "category-edit": NO_CONVERSATION_READ,
  "category-delete": NO_CONVERSATION_READ,
  "topic-create": NO_CONVERSATION_READ,
  "topic-edit": NO_CONVERSATION_READ,
  "voice-status": CONVERSATION_READ,
  "event-list": CONVERSATION_READ,
  "event-create": NO_CONVERSATION_READ,
  timeout: NO_CONVERSATION_READ,
  kick: NO_CONVERSATION_READ,
  ban: NO_CONVERSATION_READ,
  "set-profile": NO_CONVERSATION_READ,
  "set-presence": NO_CONVERSATION_READ,
  "download-file": CONVERSATION_READ,
  "upload-file": NO_CONVERSATION_READ,
} as const satisfies Record<ChannelMessageActionName, ChannelMessageActionReadPolicy>;

function resolveChannelMessageActionReadPolicy(
  action: unknown,
): ChannelMessageActionReadPolicy | undefined {
  if (typeof action !== "string" || !Object.hasOwn(CHANNEL_MESSAGE_ACTION_READ_POLICIES, action)) {
    return undefined;
  }
  return CHANNEL_MESSAGE_ACTION_READ_POLICIES[action as ChannelMessageActionName];
}

type MessageActionReadEnforcement =
  | { kind: "provider-owned"; pluginTrust: "bundled" | "external"; fenced: boolean }
  | {
      kind: "host-exact-current";
      pluginTrust: "bundled" | "external";
    };

// Context retrieval only. The broader conversation-read class also contains mutations.
const FENCED_PROVIDER_READ_ACTIONS: ReadonlySet<string> = new Set<ChannelMessageActionName>([
  "read",
  "search",
  "reactions",
  "list-pins",
  "thread-list",
  "channel-info",
  "permissions",
  "member-info",
  "role-info",
  "emoji-list",
  "channel-list",
  "voice-status",
  "event-list",
  "sticker-search",
  "download-file",
]);

export function isFencedProviderReadAction(action: string): action is ChannelMessageActionName {
  return FENCED_PROVIDER_READ_ACTIONS.has(action);
}

const SCHEDULED_MESSAGE_WRITE_POLICIES = new Map<string, "operator" | "provider">([
  ["channel-edit", "operator"],
  ["delete", "provider"],
  ["edit", "provider"],
  ["pin", "provider"],
  ["unpin", "provider"],
]);

/** Host admission stays action-specific; a plugin declaration never adds actions. */
export function isScheduledMessageWriteAction(
  action: string,
): action is "channel-edit" | "delete" | "edit" | "pin" | "unpin" {
  return SCHEDULED_MESSAGE_WRITE_POLICIES.has(action);
}

type ScheduledMessageActionAccess = {
  assertCurrent: () => void;
} & (
  | { kind: "trusted-operator" }
  | {
      kind: "account";
      channelRequester?: NonNullable<MessageActionAuthorization["scheduled"]>["channelRequester"];
    }
);

/** Validates a live scheduled grant's scope; each action consumer owns admission. */
function resolveScheduledMessageActionAccess(params: {
  authorization?: MessageActionAuthorization;
  action: ChannelMessageActionName;
  channel: string;
  accountId?: string | null;
}): ScheduledMessageActionAccess | undefined {
  const authority = params.authorization?.scheduled;
  if (!authority) {
    return undefined;
  }
  authority.assertCurrent();
  const policy = authority.policy;
  if (policy.mode === "trusted") {
    return { kind: "trusted-operator", assertCurrent: authority.assertCurrent };
  }
  if (!params.accountId || normalizeAccountId(params.accountId) !== policy.ownerAccountId) {
    throw new Error(
      `Scheduled ${params.channel}:${params.action} cannot use another creator account.`,
    );
  }
  if (params.action === "channel-edit" && normalizeMessageChannel(params.channel) === "discord") {
    const requester = authority.channelRequester;
    if (!requester) {
      throw new Error(
        "This account-bound automation needs fresh Discord requester authorization for channel-edit. " +
          "From its original Discord conversation and account, edit it with an explicit toolsAllow cap including message, or recreate it there.",
      );
    }
    if (requester.channel !== "discord" || requester.accountId !== policy.ownerAccountId) {
      throw new Error(
        "Scheduled Discord channel-edit requires its authenticated requester account and channel.",
      );
    }
    return { kind: "account", channelRequester: requester, assertCurrent: authority.assertCurrent };
  }
  const origin = policy.ownerOrigin;
  if (
    !origin ||
    origin.kind === "unknown" ||
    (origin.kind === "external" && normalizeMessageChannel(params.channel) !== origin.channel)
  ) {
    throw new Error(
      `Scheduled ${params.channel}:${params.action} requires matching recorded creator origin.`,
    );
  }
  return { kind: "account", assertCurrent: authority.assertCurrent };
}

function resolveMessageActionReadEnforcement(params: {
  action: ChannelMessageActionName;
  actions: ChannelPlugin["actions"];
  pluginOrigin: string | undefined;
  hasReadAuthority: boolean;
}): MessageActionReadEnforcement {
  const providerOwnedReadGates = params.actions?.providerOwnedReadGates;
  if (providerOwnedReadGates === true || providerOwnedReadGates?.includes(params.action) === true) {
    const fencedReadAction =
      params.actions?.readAuthorityActions?.includes(params.action) === true &&
      isFencedProviderReadAction(params.action);
    if (params.pluginOrigin === "bundled") {
      // Bundled admission stays provider-owned, but an opted-in read must use
      // its registered lifecycle owner rather than an unfenced artifact fallback.
      return { kind: "provider-owned", pluginTrust: "bundled", fenced: fencedReadAction };
    }
    if (params.hasReadAuthority && fencedReadAction) {
      return { kind: "provider-owned", pluginTrust: "external", fenced: true };
    }
  }
  return {
    kind: "host-exact-current",
    pluginTrust: params.pluginOrigin === "bundled" ? "bundled" : "external",
  };
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
  const authority = registration.captureReadAuthority?.();
  const hasRegistrationAuthority = authority?.() === true;
  const enforcement = resolveMessageActionReadEnforcement({
    action,
    actions: registration.plugin.actions,
    pluginOrigin: registration.origin,
    hasReadAuthority: hasRegistrationAuthority,
  });
  const scheduledAccess =
    isFencedProviderReadAction(action) &&
    enforcement.kind === "provider-owned" &&
    enforcement.fenced
      ? resolveScheduledMessageActionAccess({
          authorization: ctx.messageActionAuthorization,
          action,
          channel: ctx.channel,
          accountId: ctx.accountId,
        })
      : undefined;
  const origin = (
    scheduledAccess
      ? scheduledAccess.kind === "trusted-operator"
        ? "direct-operator"
        : "delegated"
      : normalizeConversationReadInvocationOrigin(ctx.conversationReadOrigin)
  ) as ServerOwnedConversationReadOrigin;
  const { messageActionAuthorization: _authorization, ...pluginContext } = ctx;
  const actionContext: ChannelMessageActionContext = {
    ...pluginContext,
    action,
    conversationReadOrigin: origin,
  };
  const assertCallerCurrent = ctx.assertDirectAdapterHandoff;
  // A dashboard grant cannot replace native provider/account context or a job grant.
  const assertDashboardReadCurrent =
    enforcement.kind === "provider-owned" &&
    enforcement.fenced &&
    !ctx.messageActionAuthorization?.scheduled &&
    ctx.toolContext === undefined &&
    ctx.requesterAccountId === undefined
      ? ctx.messageActionAuthorization?.assertDashboardReadCurrent
      : undefined;
  const assertReadAuthorityCurrent =
    (origin !== "direct-operator" || scheduledAccess) &&
    enforcement.kind === "provider-owned" &&
    enforcement.fenced
      ? () => {
          assertCallerCurrent?.();
          assertDashboardReadCurrent?.();
          scheduledAccess?.assertCurrent();
          if (!authority?.()) {
            throw new Error(`Plugin ${ctx.channel} read authority is no longer active.`);
          }
        }
      : undefined;
  return {
    actionContext,
    plugin: registration.plugin,
    origin,
    actionPolicy,
    enforcement,
    scheduledAccess,
    assertDashboardReadCurrent,
    hasRegistrationAuthority,
    assertReadAuthorityCurrent,
    assertAliasAuthorityCurrent: () => {
      assertCallerCurrent?.();
      assertDashboardReadCurrent?.();
      scheduledAccess?.assertCurrent();
      const current =
        registration.captureReadAuthority && !authority?.()
          ? undefined
          : resolveChannelPluginRegistration(ctx.channel, { loadedOnly: true });
      if (current?.plugin !== registration.plugin || current.origin !== registration.origin) {
        throw new Error(`Plugin ${ctx.channel} alias authority is no longer active.`);
      }
    },
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

type MessageActionConversationReadGateParams = {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
  origin: ServerOwnedConversationReadOrigin;
  actionPolicy: ChannelMessageActionReadPolicy;
  enforcement: MessageActionReadEnforcement;
  scheduledAccess?: ScheduledMessageActionAccess;
  assertDashboardReadCurrent?: () => void;
};

/** The shared host decision before any read-capable plugin callback runs. */
function resolveMessageActionConversationReadGate(
  params: MessageActionConversationReadGateParams,
): CurrentConversationMatch {
  if (params.actionPolicy.kind === "none" || params.origin === "direct-operator") {
    return true;
  }
  if (params.enforcement.kind === "provider-owned") {
    // Restore cross-conversation reads, not missing-origin or cross-account authority.
    if (
      params.enforcement.fenced &&
      params.enforcement.pluginTrust === "external" &&
      !params.scheduledAccess &&
      !params.assertDashboardReadCurrent &&
      (!hasMatchingCurrentProviderContext(params.ctx) ||
        !hasMatchingCurrentAccountContext(params.ctx) ||
        !hasCurrentConversationTarget(params.ctx))
    ) {
      throw new Error(
        `Delegated ${params.ctx.channel}:${params.ctx.action} requires current provider and account context.`,
      );
    }
    return true;
  }

  const isBundledCurrentContextCacheRead =
    params.enforcement.pluginTrust === "bundled" &&
    params.actionPolicy.targetlessCache === "bundled-current-context" &&
    hasMatchingCurrentProviderContext(params.ctx) &&
    hasMatchingCurrentAccountContext(params.ctx) &&
    hasCurrentConversationTarget(params.ctx);
  return (
    isBundledCurrentContextCacheRead ||
    resolveExactCurrentConversationMatch({
      ctx: params.ctx,
      plugin: params.plugin,
      pluginTrust: params.enforcement.pluginTrust,
    })
  );
}

function enforceMessageActionConversationReadMatch(
  params: MessageActionConversationReadGateParams,
  matches: boolean,
): void {
  if (!matches) {
    throw new Error(
      `Delegated ${params.ctx.channel}:${params.ctx.action} requires the exact current conversation and account for this plugin.`,
    );
  }
  if (
    params.actionPolicy.kind === "conversation-read" &&
    params.origin !== "direct-operator" &&
    params.enforcement.kind === "host-exact-current" &&
    params.enforcement.pluginTrust === "external"
  ) {
    canonicalizeExternalExactCurrentTarget(params.ctx);
  }
}

function enforceMessageActionConversationReadGate(
  params: MessageActionConversationReadGateParams,
): void {
  // External pre-resolution admission never invokes bundled alias matchers.
  enforceMessageActionConversationReadMatch(
    params,
    resolveMessageActionConversationReadGate(params) === true,
  );
}

function prepareScheduledMessageWriteContext(
  ctx: ChannelMessageActionDispatchContext,
  prepared: PreparedMessageActionReadContext,
): ChannelMessageActionContext | undefined {
  const action = prepared.actionContext.action;
  const policy = SCHEDULED_MESSAGE_WRITE_POLICIES.get(action);
  if (!policy || !ctx.messageActionAuthorization?.scheduled) {
    return undefined;
  }
  if (
    policy === "provider" &&
    prepared.enforcement.kind === "provider-owned" &&
    prepared.enforcement.pluginTrust === "bundled" &&
    !prepared.plugin.actions?.writeAuthorityActions?.includes(action)
  ) {
    // Retain existing bundled provider admission until its adapter opts into this fence.
    return undefined;
  }
  const accountId =
    ctx.accountId ?? resolveChannelDefaultAccountId({ plugin: prepared.plugin, cfg: ctx.cfg });
  const access = resolveScheduledMessageActionAccess({
    authorization: ctx.messageActionAuthorization,
    action,
    channel: ctx.channel,
    accountId,
  });
  if (!access) {
    return undefined;
  }
  const channelRequester = access.kind === "account" ? access.channelRequester : undefined;
  if (policy === "operator" && access.kind !== "trusted-operator" && !channelRequester) {
    throw new Error(
      `Scheduled ${ctx.channel}:${action} requires a job authorized by an operator. Account jobs cannot inherit operator administration.`,
    );
  }
  if (policy === "provider") {
    const providerGates = prepared.plugin.actions?.providerOwnedReadGates;
    if (providerGates !== true && !providerGates?.includes(action)) {
      throw new Error(
        `Scheduled ${ctx.channel}:${action} requires provider-owned target authorization.`,
      );
    }
  }
  return prepareMessageActionWriteAuthority({
    context: {
      ...prepared.actionContext,
      accountId,
      ...(channelRequester
        ? {
            requesterAccountId: channelRequester.accountId,
            requesterSenderId: channelRequester.senderId,
            senderIsOwner: false,
            toolContext: undefined,
          }
        : { senderIsOwner: policy === "operator" ? true : prepared.actionContext.senderIsOwner }),
      conversationReadOrigin:
        policy === "operator"
          ? prepared.actionContext.conversationReadOrigin
          : access.kind === "trusted-operator"
            ? "direct-operator"
            : "delegated",
      assertDirectAdapterHandoff: prepared.assertAliasAuthorityCurrent,
    },
    plugin: prepared.plugin,
    hasRegistrationAuthority: prepared.hasRegistrationAuthority,
    assertCurrent: access.assertCurrent,
  });
}

/** Admit provider preparation before resolving an external target. */
export function prepareExternalMessageActionTargetForResolution(
  ctx: ChannelMessageActionDispatchContext,
): {
  params: Record<string, unknown>;
  accountId?: string | null;
  assertReadAuthorityCurrent?: () => void;
  assertTargetAuthorityCurrent?: () => void;
} {
  const prepared = prepareMessageActionReadContext(ctx);
  const scheduledWrite = prepared && prepareScheduledMessageWriteContext(ctx, prepared);
  if (scheduledWrite) {
    return {
      params: ctx.params,
      accountId: scheduledWrite.accountId,
      assertTargetAuthorityCurrent: scheduledWrite.assertDirectAdapterHandoff,
    };
  }
  if (prepared?.assertReadAuthorityCurrent) {
    prepared.assertReadAuthorityCurrent();
    enforceMessageActionConversationReadGate({
      ctx: prepared.actionContext,
      ...prepared,
    });
    return { params: ctx.params, assertReadAuthorityCurrent: prepared.assertReadAuthorityCurrent };
  }
  if (!isExternalDelegatedMessageActionRead(prepared)) {
    return { params: ctx.params };
  }
  // External target resolution can execute plugin directory/provider lookups.
  // Establish exact-current authority before that boundary, then recheck at dispatch.
  const authorizedActionContext = attachExternalCurrentTargetSibling({
    ctx: prepared.actionContext,
    ...prepared,
  });
  enforceMessageActionConversationReadGate({
    ctx: authorizedActionContext,
    ...prepared,
  });
  return { params: authorizedActionContext.params };
}

/** Defers delegated external target interpretation to the attested Gateway boundary. */
export function shouldDeferExternalMessageActionTargetResolution(
  ctx: ChannelMessageActionDispatchContext,
): boolean {
  const prepared = prepareMessageActionReadContext(ctx);
  // Scheduled writers and official reads wait for the Gateway's attested
  // requester and live registry before any alias lookup.
  return (
    isExternalDelegatedMessageActionRead(prepared) ||
    Boolean(prepared?.assertReadAuthorityCurrent) ||
    Boolean(
      prepared &&
      ctx.messageActionAuthorization?.scheduled &&
      isScheduledMessageWriteAction(prepared.actionContext.action),
    )
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
  ctx: ChannelMessageActionDispatchContext,
): Promise<AgentToolResult<unknown> | null> {
  const prepared = prepareMessageActionReadContext(ctx);
  if (!prepared) {
    return null;
  }
  const scheduledWrite = prepareScheduledMessageWriteContext(ctx, prepared);
  const run = (actionContext: ChannelMessageActionContext) =>
    withChannelReadAuthority(prepared.assertReadAuthorityCurrent, async () => {
      const { plugin } = prepared;
      const actions = plugin.actions;
      if (!actions?.handleAction) {
        return null;
      }
      const authorizedActionContext = attachExternalCurrentTargetSibling({
        ctx: actionContext,
        ...prepared,
      });
      const gateParams = {
        ctx: authorizedActionContext,
        ...prepared,
      };
      // This writer passed the private job/account gate and declared provider target checks.
      const match =
        scheduledWrite && SCHEDULED_MESSAGE_WRITE_POLICIES.get(actionContext.action) === "provider"
          ? true
          : resolveMessageActionConversationReadGate(gateParams);
      let matches: boolean;
      if (typeof match === "function") {
        prepared.assertAliasAuthorityCurrent();
        matches = await match();
        prepared.assertAliasAuthorityCurrent();
      } else {
        matches = match;
      }
      enforceMessageActionConversationReadMatch(gateParams, matches);
      // Some plugin actions depend on the sender identity to enforce channel-local
      // trust. Reject tool-driven calls before invoking the action without it.
      if (
        requiresTrustedRequesterSender(authorizedActionContext, plugin) &&
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
      authorizedActionContext.assertDirectAdapterHandoff?.();
      prepared.assertReadAuthorityCurrent?.();
      if (typeof match === "function") {
        prepared.assertAliasAuthorityCurrent();
      }
      return await actions.handleAction(authorizedActionContext);
    });
  if (!scheduledWrite) {
    return await run(prepared.actionContext);
  }
  return await withMessageActionWriteAuthority({ context: scheduledWrite, run });
}
