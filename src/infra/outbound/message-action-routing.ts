import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { readToolStringParam } from "../../agents/tools/common.js";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  prepareExternalMessageActionTargetForResolution,
  shouldDeferExternalMessageActionTargetResolution,
} from "../../channels/plugins/message-action-dispatch.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { resolveFirstBoundAccountId } from "../../routing/bound-account-read.js";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";
import type { MessageActionInput } from "./message-action-contracts.js";
import {
  normalizeMessageActionInput,
  resolveImplicitMessageActionTarget,
} from "./message-action-normalization.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";
import { actionRequiresTarget } from "./message-action-spec.js";
import { enforceCrossContextPolicy } from "./outbound-policy.js";
import {
  invalidMessageActionTargetError,
  missingMessageActionTargetError,
} from "./target-errors.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";

function addTargetCandidates(candidates: Set<string>, value: string, channel?: ChannelId) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return;
  }
  candidates.add(normalized);
  const unprefixed = normalized.replace(/^(channel|group|user):/i, "").trim();
  if (unprefixed && unprefixed !== normalized) {
    candidates.add(unprefixed);
  }
  if (channel !== undefined) {
    const target = normalizeTargetForAccountBinding(channel, value);
    if (target) {
      addTargetCandidates(candidates, target);
    }
  }
}

function normalizeTargetForAccountBinding(channel: ChannelId, target: string): string | undefined {
  try {
    return normalizeTargetForProvider(channel, target);
  } catch {
    return undefined;
  }
}

function inferPeerKindForAccountBinding(
  channel: ChannelId,
  target: string,
  channelPlugin?: ChannelPlugin,
): ChatType | undefined {
  const inferred = normalizeChatType(
    channelPlugin?.messaging?.inferTargetChatType?.({ to: target }),
  );
  if (inferred) {
    return inferred;
  }
  const normalized = normalizeTargetForAccountBinding(channel, target);
  const candidates = [target, normalized].filter((value): value is string => Boolean(value));
  if (candidates.some((value) => /^user:/i.test(value))) {
    return "direct";
  }
  if (candidates.some((value) => /^(channel|group):/i.test(value))) {
    return "channel";
  }
  return undefined;
}

function resolveTargetBoundAccountId(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  channelPlugin?: ChannelPlugin;
  args: Record<string, unknown>;
  agentId?: string;
}): string | undefined {
  if (!params.agentId) {
    return undefined;
  }
  const target = readTrimmedStringAlias(params.args, ["to", "channelId"]);
  if (!target) {
    return resolveFirstBoundAccountId({
      cfg: params.cfg,
      channelId: params.channel,
      agentId: params.agentId,
    });
  }

  const candidates = new Set<string>();
  addTargetCandidates(candidates, target, params.channel);
  const [peerId, ...exactPeerIdAliases] = Array.from(candidates);
  return resolveFirstBoundAccountId({
    cfg: params.cfg,
    channelId: params.channel,
    agentId: params.agentId,
    peerId,
    exactPeerIdAliases,
    peerKind: inferPeerKindForAccountBinding(params.channel, target, params.channelPlugin),
  });
}

function hasExplicitSingularTargetParam(params: Record<string, unknown>): boolean {
  return readTrimmedStringAlias(params, ["target", "to", "channelId"]) !== undefined;
}

function hasExplicitTargetParam(params: Record<string, unknown>): boolean {
  return (
    hasExplicitSingularTargetParam(params) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => normalizeOptionalString(value)))
  );
}

function hasPotentialActionTargetInput(
  input: MessageActionInput,
  params: Record<string, unknown>,
): boolean {
  return Boolean(
    hasExplicitSingularTargetParam(params) ||
    resolveImplicitMessageActionTarget(input.toolContext) ||
    hasPotentialPluginActionParam(params),
  );
}

function isCurrentSourceTargetParam(
  input: MessageActionInput,
  params: Record<string, unknown>,
): boolean {
  const currentChannelId = normalizeOptionalString(input.toolContext?.currentChannelId);
  const currentMessagingTarget = normalizeOptionalString(input.toolContext?.currentMessagingTarget);
  if (!currentChannelId && !currentMessagingTarget) {
    return false;
  }
  const currentChannelProvider = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  const explicitChannel = normalizeOptionalLowercaseString(params.channel);
  if (explicitChannel && currentChannelProvider && explicitChannel !== currentChannelProvider) {
    return false;
  }

  const explicitTarget = readTrimmedStringAlias(params, ["target", "to", "channelId"]);
  if (!explicitTarget) {
    return false;
  }

  const provider = explicitChannel ?? currentChannelProvider;
  const currentCandidates = new Set<string>();
  for (const currentTarget of [currentMessagingTarget, currentChannelId]) {
    if (!currentTarget) {
      continue;
    }
    addTargetCandidates(currentCandidates, currentTarget, provider);
  }

  const explicitCandidates = new Set<string>();
  addTargetCandidates(explicitCandidates, explicitTarget, provider);
  return Array.from(explicitCandidates).some((candidate) => currentCandidates.has(candidate));
}

function hasExplicitNonCurrentChannelParam(
  input: MessageActionInput,
  params: Record<string, unknown>,
): boolean {
  const explicitChannel = normalizeOptionalLowercaseString(params.channel);
  if (!explicitChannel) {
    return false;
  }
  const currentChannelProvider = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  return !currentChannelProvider || explicitChannel !== currentChannelProvider;
}

function applyImplicitSourceReplySendPolicy(
  input: MessageActionInput,
  params: Record<string, unknown>,
) {
  if (input.action !== "send" || input.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  if (hasExplicitNonCurrentChannelParam(input, params)) {
    return;
  }
  if (hasExplicitTargetParam(params) && !isCurrentSourceTargetParam(input, params)) {
    return;
  }
  params.bestEffort = true;
}

type PreparedMessageRoute = {
  params: Record<string, unknown>;
  channel: ChannelId;
  channelPlugin: ChannelPlugin;
  accountId?: string | null;
  dryRun: boolean;
  defersExternalTargetResolution: boolean;
  assertReadAuthorityCurrent?: () => void;
  assertTargetAuthorityCurrent?: () => void;
};

export async function prepareMessageRoute(params: {
  input: MessageActionInput;
  actionParams: Record<string, unknown>;
  agentId?: string;
}): Promise<PreparedMessageRoute> {
  const { input, agentId } = params;
  const cfg = input.cfg;
  const action = input.action;
  let actionParams = params.actionParams;

  applyImplicitSourceReplySendPolicy(input, actionParams);
  // Missing targets must fail before channel discovery, which can bootstrap or
  // probe configured plugins. Non-standard params may still be owner aliases.
  if (actionRequiresTarget(action) && !hasPotentialActionTargetInput(input, actionParams)) {
    throw missingMessageActionTargetError(action);
  }

  const requestedChannel = readToolStringParam(actionParams, "channel");
  const { channel, plugin: channelPlugin } = await resolveMessageChannelSelection({
    cfg,
    channel: requestedChannel,
    // Explicit reads must never fall back to the source conversation's provider.
    fallbackChannel:
      action === "read" && requestedChannel ? undefined : input.toolContext?.currentChannelProvider,
    agentId,
  });
  actionParams.channel = channel;
  const explicitAccountId = await validateExplicitMessageAccountSelection({
    cfg,
    channel,
    accountId: readToolStringParam(actionParams, "accountId"),
    plugin: channelPlugin,
  });
  const pluginOwnedAction = action !== "send" && action !== "poll";
  if (
    pluginOwnedAction &&
    channelPlugin?.actions?.supportsAction &&
    !channelPlugin.actions.supportsAction({ action })
  ) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  actionParams = normalizeMessageActionInput({
    action,
    args: actionParams,
    toolContext: input.toolContext,
    targetAliasSpec: channelPlugin?.actions?.messageActionTargetAliases?.[action] ?? null,
    // Trusted direct operators retain opaque resource-id workflows. Native conversation
    // aliases still normalize above and remain subject to the shared cross-context policy.
    allowResourceOnly: input.conversationReadOrigin === "direct-operator",
  });
  let accountId = explicitAccountId ?? input.defaultAccountId;
  if (!accountId && agentId) {
    accountId = resolveTargetBoundAccountId({
      cfg,
      channel,
      channelPlugin,
      args: actionParams,
      agentId,
    });
  }
  const delegatesActionToGateway =
    Boolean(input.gateway) &&
    channelPlugin?.actions?.resolveExecutionMode?.({ action }) === "gateway";
  // Resolve once for locally owned sends so formatting and delivery share an
  // identity. Remote calls must retain omitted input for the Gateway to resolve.
  if (
    !accountId &&
    action === "send" &&
    !delegatesActionToGateway &&
    (channelPlugin.outbound?.deliveryMode !== "gateway" || input.gatewayOwnedDelivery === true)
  ) {
    accountId = resolveChannelDefaultAccountId({ plugin: channelPlugin, cfg });
  }
  if (accountId) {
    actionParams.accountId = accountId;
  }
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(actionParams, "dryRun"));
  const currentProvider = input.toolContext?.currentChannelProvider;
  if (currentProvider && currentProvider !== channel) {
    // Cross-provider egress needs no target lookup, so reject it before provider I/O.
    // Same-provider aliases still wait for canonicalization below; direct operators
    // bypass conversation-read visibility, never the shared egress policy.
    enforceCrossContextPolicy({
      channel,
      action,
      args: actionParams,
      toolContext: input.toolContext,
      cfg,
      agentId,
    });
  }
  const defersExternalTargetResolution =
    delegatesActionToGateway &&
    !dryRun &&
    shouldDeferExternalMessageActionTargetResolution({
      channel,
      action,
      cfg,
      params: actionParams,
      accountId: accountId ?? undefined,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      messageActionAuthorization: input.messageActionAuthorization,
    });
  let assertReadAuthorityCurrent: (() => void) | undefined;
  let assertTargetAuthorityCurrent: (() => void) | undefined;
  if (!delegatesActionToGateway || dryRun) {
    const authorization = input.messageActionAuthorization;
    const preparedRead = await prepareExternalMessageActionTargetForResolution({
      channel,
      action,
      cfg,
      params: actionParams,
      accountId: accountId ?? undefined,
      agentId,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      requesterAccountId:
        authorization !== undefined
          ? authorization.requesterAccountId
          : (input.requesterAccountId ?? undefined),
      requesterSenderId:
        authorization !== undefined
          ? authorization.requesterSenderId
          : (input.requesterSenderId ?? undefined),
      senderIsOwner: input.senderIsOwner,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      toolContext: authorization !== undefined ? authorization.toolContext : input.toolContext,
      messageActionAuthorization: authorization,
      assertDirectAdapterHandoff: input.assertDirectAdapterHandoff,
    });
    actionParams = preparedRead.params;
    accountId = preparedRead.accountId ?? accountId;
    assertReadAuthorityCurrent = preparedRead.assertReadAuthorityCurrent;
    assertTargetAuthorityCurrent = preparedRead.assertTargetAuthorityCurrent;
  }

  return {
    params: actionParams,
    channel,
    channelPlugin,
    accountId,
    dryRun,
    defersExternalTargetResolution,
    assertReadAuthorityCurrent,
    assertTargetAuthorityCurrent,
  };
}

export async function resolveMessageTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  agentId?: string | null;
  deferExternalTargetResolution?: boolean;
  plugin?: ChannelPlugin;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  if (!params.deferExternalTargetResolution) {
    for (const key of ["to", "channelId"] as const) {
      const input = normalizeOptionalString(params.args[key]);
      if (!input) {
        continue;
      }
      const resolved = await resolveChannelTarget({
        cfg: params.cfg,
        channel: params.channel,
        input,
        accountId: params.accountId ?? undefined,
        plugin: params.plugin,
        ...(key === "channelId" ? { preferredKind: "group" as const } : {}),
      });
      if (!resolved.ok) {
        throw resolved.error;
      }
      const target = resolved.target;
      if (key === "channelId" && target.kind === "user") {
        throw invalidMessageActionTargetError(`Channel id "${input}" resolved to a user target.`);
      }
      if (key === "to") {
        resolvedTarget = target;
      }
      params.args[key] = key === "to" ? target.to : target.to.replace(/^(channel|group):/i, "");
    }
  }

  enforceCrossContextPolicy({
    channel: params.channel,
    action: params.action,
    args: params.args,
    toolContext: params.toolContext,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return resolvedTarget;
}
