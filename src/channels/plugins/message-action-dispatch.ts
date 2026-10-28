import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import { assertOutboundHandoffCurrent } from "../../infra/outbound/deliver-handoff.js";
import { validateExplicitMessageAccountSelection } from "../../infra/outbound/message-account-selection.js";
import { enforceMessageActionAllowlist } from "../../infra/outbound/outbound-policy.js";
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
import {
  resolveChannelMessageActionFacts,
  type ChannelMessageActionName,
  type ChannelMessageActionReadPolicy,
} from "./message-action-names.js";
import { resolveChannelPluginRegistration } from "./registry.js";
import type { ChannelMessageActionContext } from "./types.core.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";

/** Admit preparation and execution against the same invocation configuration. */
async function prepareMessageActionWriteAuthority(params: {
  context: ChannelMessageActionContext & { accountId: string };
  plugin: ChannelPlugin;
  hasRegistrationAuthority: boolean;
  assertCurrent: () => void;
}): Promise<ChannelMessageActionContext> {
  const { context, plugin } = params;
  const { action, channel, accountId } = context;
  if (
    !params.hasRegistrationAuthority ||
    !plugin.actions?.writeAuthorityActions?.includes(action)
  ) {
    throw new Error(
      `Scheduled ${channel}:${action} requires an active bundled or verified official plugin with write authorization support. Update and reload a supported plugin, then retry.`,
    );
  }
  const assertCurrent = () => {
    params.assertCurrent();
    context.assertDirectAdapterHandoff?.();
  };
  assertCurrent();
  // Configuration governs admission; later retries retain that decision while
  // still checking the live job, caller, and selected plugin before every request.
  const cfg = context.cfg;
  enforceMessageActionAllowlist({ cfg, agentId: context.agentId, action });
  await validateExplicitMessageAccountSelection({ cfg, channel, accountId, plugin });
  assertCurrent();
  const discoveryContext = {
    cfg,
    accountId,
    agentId: context.agentId ?? undefined,
    sessionKey: context.sessionKey ?? undefined,
    sessionId: context.sessionId ?? undefined,
    requesterSenderId: context.requesterSenderId ?? undefined,
    senderIsOwner: context.senderIsOwner,
  };
  const available = plugin.actions.describeMessageToolAsync
    ? await plugin.actions.describeMessageToolAsync(discoveryContext)
    : plugin.actions.describeMessageTool(discoveryContext);
  assertCurrent();
  if (!available?.actions?.includes(action)) {
    throw new Error(`Scheduled ${channel}:${action} is disabled for this account.`);
  }
  return { ...context, accountId, assertDirectAdapterHandoff: assertCurrent };
}

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

type MessageActionReadEnforcement =
  | { kind: "provider-owned"; pluginTrust: "bundled" | "external"; fenced: boolean }
  | {
      kind: "host-exact-current";
      pluginTrust: "bundled" | "external";
    };

export function isFencedProviderReadAction(action: string): action is ChannelMessageActionName {
  return resolveChannelMessageActionFacts(action)?.fencedRead === true;
}

/** Host admission stays action-specific; a plugin declaration never adds actions. */
export function isScheduledMessageWriteAction(
  action: string,
): action is "channel-edit" | "delete" | "edit" | "pin" | "unpin" {
  return resolveChannelMessageActionFacts(action)?.scheduledWrite !== undefined;
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
  const assertCurrent = authority.assertSourceCurrent ?? authority.assertCurrent;
  assertCurrent();
  const policy = authority.policy;
  if (policy.mode === "trusted") {
    return { kind: "trusted-operator", assertCurrent };
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
    return { kind: "account", channelRequester: requester, assertCurrent };
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
  return { kind: "account", assertCurrent };
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
  if (!trustedCurrentTarget) {
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
  const actionPolicy = resolveChannelMessageActionFacts(ctx.action)?.readPolicy;
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

async function prepareScheduledMessageWriteContext(
  ctx: ChannelMessageActionDispatchContext,
  prepared: PreparedMessageActionReadContext,
): Promise<ChannelMessageActionContext | undefined> {
  const action = prepared.actionContext.action;
  const policy = resolveChannelMessageActionFacts(action)?.scheduledWrite;
  if (!policy || !ctx.messageActionAuthorization?.scheduled) {
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
export async function prepareExternalMessageActionTargetForResolution(
  ctx: ChannelMessageActionDispatchContext,
): Promise<{
  params: Record<string, unknown>;
  accountId?: string | null;
  assertReadAuthorityCurrent?: () => void;
  assertTargetAuthorityCurrent?: () => void;
}> {
  const prepared = prepareMessageActionReadContext(ctx);
  const scheduledWrite = prepared && (await prepareScheduledMessageWriteContext(ctx, prepared));
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
  const scheduledWrite =
    ctx.messageActionAuthorization?.scheduled &&
    isScheduledMessageWriteAction(prepared.actionContext.action)
      ? await prepareScheduledMessageWriteContext(ctx, prepared)
      : undefined;
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
        scheduledWrite &&
        resolveChannelMessageActionFacts(actionContext.action)?.scheduledWrite === "provider"
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
        plugin.actions?.requiresTrustedRequesterSender?.({
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
      try {
        await authorizedActionContext.onPlatformSendDispatch?.();
      } catch (error) {
        assertOutboundHandoffCurrent(authorizedActionContext.assertDirectAdapterHandoff);
        throw error;
      }
      assertOutboundHandoffCurrent(authorizedActionContext.assertDirectAdapterHandoff);
      prepared.assertReadAuthorityCurrent?.();
      if (typeof match === "function") {
        prepared.assertAliasAuthorityCurrent();
      }
      return await actions.handleAction(authorizedActionContext);
    });
  if (!scheduledWrite) {
    return await run(prepared.actionContext);
  }
  /** Retain an admitted writer's request guard through provider settlement. */
  const context = scheduledWrite;
  let open = true;
  const assertCurrent = () => {
    if (!open) {
      throw new Error(
        `Scheduled ${context.channel}:${context.action} invocation is no longer active.`,
      );
    }
    context.assertDirectAdapterHandoff?.();
  };
  try {
    assertCurrent();
    return await run({ ...context, assertDirectAdapterHandoff: assertCurrent });
  } finally {
    // Submitted requests settle; neither success nor rejection leaves a replayable callback.
    open = false;
  }
}
