import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import { readToolStringParam } from "../../agents/tools/common.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { resolveChannelMessageActionFacts } from "../../channels/plugins/message-action-names.js";
import { resolveSessionConversation } from "../../channels/plugins/session-conversation.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageToolsConfig } from "../../config/types.tools.js";
import type { MessagePresentation } from "../../interactive/payload.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { resolveAndApplyOutboundThreadId } from "./message-action-threading.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { formatTargetDisplay, lookupDirectoryDisplay } from "./target-resolver.js";

export type CrossContextDecoration = {
  prefix: string;
  suffix: string;
  presentationBuilder?: (message: string) => MessagePresentation;
};

function normalizeTarget(channel: ChannelId, raw: string): string | undefined {
  return normalizeTargetForProvider(channel, raw) ?? raw.trim();
}

function isCrossContextTarget(params: {
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
}): boolean {
  if (
    params.toolContext &&
    getChannelPlugin(params.channel)?.threading?.matchesToolContextTarget?.({
      target: params.target,
      toolContext: params.toolContext,
    })
  ) {
    return false;
  }
  const currentTargets = [
    params.toolContext?.currentMessagingTarget?.trim(),
    params.toolContext?.currentChannelId?.trim(),
  ].filter((target): target is string => Boolean(target));
  if (currentTargets.length === 0) {
    return false;
  }
  const normalizedTarget = normalizeTarget(params.channel, params.target);
  if (!normalizedTarget) {
    return false;
  }
  return !currentTargets.some(
    (currentTarget) => normalizeTarget(params.channel, currentTarget) === normalizedTarget,
  );
}

// The runner delivers send and poll into the thread it resolves. Other actions only hand that
// thread to the plugin, which may act on the base chat instead (Telegram's topic-create).
const THREAD_DELIVERY_ACTIONS: ReadonlySet<ChannelMessageActionName> = new Set(["send", "poll"]);
// A new topic is a sibling conversation in the parent chat, whatever topic or thread the request
// names, so that parent chat must be the current conversation too.
const PARENT_CONVERSATION_ACTIONS: ReadonlySet<ChannelMessageActionName> = new Set([
  "topic-create",
]);

/** Names a target's parent conversation with the channel's own conversation grammar. */
function resolveParentConversationTarget(channel: ChannelId, target: string): string {
  return (
    resolveSessionConversation({ channel, kind: "group", rawId: target })?.baseConversationId ??
    target
  );
}

/** Names the conversation an action's thread selects where threads are their own conversations. */
function resolveThreadedTarget(params: {
  channel: ChannelId;
  target: string;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  cfg: OpenClawConfig;
}): string {
  const threading = getChannelPlugin(params.channel)?.threading;
  if (!threading?.resolveCurrentChannelId) {
    return params.target;
  }
  // Delivery applies explicit and inherited thread ids after this check; judge the same
  // destination on a copy so policy never writes action params.
  const threadId = resolveAndApplyOutboundThreadId(
    { ...params.args },
    {
      cfg: params.cfg,
      to: params.target,
      accountId: readToolStringParam(params.args, "accountId"),
      toolContext: params.toolContext,
      resolveAutoThreadId: threading.resolveAutoThreadId,
    },
  );
  return threadId
    ? (threading.resolveCurrentChannelId({ to: params.target, threadId }) ?? params.target)
    : params.target;
}

/** Lists the conversations an action's effect can reach; each must be the current one. */
function resolveJudgedTargets(
  params: Parameters<typeof enforceCrossContextPolicy>[0],
  requestedTarget: string,
): string[] {
  if (PARENT_CONVERSATION_ACTIONS.has(params.action)) {
    return [resolveParentConversationTarget(params.channel, requestedTarget), requestedTarget];
  }
  const threadedTarget = resolveThreadedTarget({ ...params, target: requestedTarget });
  // An inherited thread is not authority for an effect outside it: other actions must also
  // request the current conversation, and a thread they carry can only narrow that.
  return THREAD_DELIVERY_ACTIONS.has(params.action)
    ? [threadedTarget]
    : [requestedTarget, threadedTarget];
}

function mergeMessagePolicy<T extends object>(global: T | undefined, agent: T | undefined) {
  return global || agent ? { ...global, ...agent } : undefined;
}

export function resolveEffectiveMessageToolsConfig(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
}): MessageToolsConfig | undefined {
  const { cfg, agentId } = params;
  const trimmedAgentId = agentId?.trim();
  const globalConfig = cfg.tools?.message;
  if (!trimmedAgentId) {
    return globalConfig;
  }
  const agentConfig = resolveAgentConfig(cfg, trimmedAgentId)?.tools?.message;
  if (!agentConfig) {
    return globalConfig;
  }
  const crossContext = mergeMessagePolicy(globalConfig?.crossContext, agentConfig.crossContext);
  // Agent message-tool policy is an override layer; nested policy groups must merge independently.
  return {
    ...globalConfig,
    ...agentConfig,
    crossContext: crossContext
      ? {
          ...crossContext,
          marker: mergeMessagePolicy(
            globalConfig?.crossContext?.marker,
            agentConfig.crossContext?.marker,
          ),
        }
      : undefined,
    broadcast: mergeMessagePolicy(globalConfig?.broadcast, agentConfig.broadcast),
    actions: mergeMessagePolicy(globalConfig?.actions, agentConfig.actions),
  };
}

export function resolveAllowedMessageActions(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
}): string[] | undefined {
  const allow = resolveEffectiveMessageToolsConfig(params)?.actions?.allow;
  if (!allow) {
    return undefined;
  }
  const normalized = normalizeUniqueStringEntries(allow);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Rejects disabled message actions before channel-specific send handling runs.
 */
export function enforceMessageActionAllowlist(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  action: ChannelMessageActionName;
}): void {
  const allowed = resolveAllowedMessageActions(params);
  if (!allowed || allowed.includes(params.action)) {
    return;
  }
  throw new MessageActionDeniedError(
    `Message action "${params.action}" is disabled for this agent.`,
    "message_action_disabled",
    "message-actions:allowlist",
  );
}

/**
 * Enforces source-provider policy independently of channel/thread target availability.
 */
export function enforceCrossContextPolicy(params: {
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  cfg: OpenClawConfig;
  agentId?: string | null;
}): void {
  if (!resolveChannelMessageActionFacts(params.action)?.crossContext) {
    return;
  }

  const crossContext = resolveEffectiveMessageToolsConfig(params)?.crossContext;
  // Doctor moves the shipped allowCrossContextSend flag into this canonical policy.
  // Runtime must not keep a second legacy interpretation path here.
  const currentProvider = params.toolContext?.currentChannelProvider;
  // Confinement keys on the host-reported conversation kind; turns without one are not confined.
  const chatType = params.toolContext?.currentChatType;
  const confined =
    chatType !== undefined && crossContext?.confineChatTypes?.includes(chatType) === true;
  const confinedReason = confined
    ? ` tools.message.crossContext.confineChatTypes keeps ${chatType} turns in their current conversation.`
    : "";
  const allowWithinProvider = !confined && crossContext?.allowWithinProvider !== false;
  const allowAcrossProviders = !confined && crossContext?.allowAcrossProviders !== false;

  // Provider mismatch is stronger than target mismatch; normalize targets only within one provider.
  if (currentProvider && currentProvider !== params.channel) {
    if (!allowAcrossProviders) {
      throw new MessageActionDeniedError(
        `Cross-context messaging denied: action=${params.action} target provider "${params.channel}" while bound to "${currentProvider}".${confinedReason}`,
        "message_cross_context_denied",
        "message-cross-context:provider",
      );
    }
    return;
  }

  if (allowWithinProvider) {
    return;
  }

  const currentTarget =
    params.toolContext?.currentChannelId?.trim() ??
    params.toolContext?.currentMessagingTarget?.trim();
  if (!currentTarget) {
    return;
  }

  const targetKeys =
    params.action === "thread-reply" || params.action === "thread-create"
      ? ["channelId", "to"]
      : ["to", "channelId"];
  let requestedTarget: string | undefined;
  for (const key of targetKeys) {
    if (typeof params.args[key] === "string") {
      requestedTarget = params.args[key];
      break;
    }
  }
  if (!requestedTarget) {
    return;
  }
  const target = resolveJudgedTargets(params, requestedTarget).find((candidate) =>
    isCrossContextTarget({ ...params, target: candidate }),
  );
  if (!target) {
    return;
  }

  throw new MessageActionDeniedError(
    `Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).${confinedReason}`,
    "message_cross_context_denied",
    "message-cross-context:target",
  );
}

export async function buildCrossContextDecoration(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  agentId?: string | null;
}): Promise<CrossContextDecoration | null> {
  const currentTarget =
    params.toolContext?.currentChannelId ?? params.toolContext?.currentMessagingTarget;
  // Direct tool sends are authored for their destination, not forwarded from a bound context.
  if (
    !currentTarget ||
    params.toolContext?.skipCrossContextDecoration ||
    !isCrossContextTarget(params)
  ) {
    return null;
  }

  const markerConfig = resolveEffectiveMessageToolsConfig(params)?.crossContext?.marker;
  if (markerConfig?.enabled === false) {
    return null;
  }

  const currentName =
    (await lookupDirectoryDisplay({
      cfg: params.cfg,
      channel: params.channel,
      targetId: currentTarget,
      accountId: params.accountId ?? undefined,
    })) ?? currentTarget;
  // Don't force group formatting here; currentChannelId can be a DM or a group.
  const originLabel = formatTargetDisplay({
    channel: params.channel,
    target: currentTarget,
    display: currentName,
  });
  const prefixTemplate = markerConfig?.prefix ?? "[from {channel}] ";
  const suffixTemplate = markerConfig?.suffix ?? "";
  const prefix = prefixTemplate.replaceAll("{channel}", originLabel);
  const suffix = suffixTemplate.replaceAll("{channel}", originLabel);

  const buildPresentation = getChannelPlugin(params.channel)?.messaging
    ?.buildCrossContextPresentation;
  const presentationBuilder = buildPresentation
    ? (message: string) =>
        buildPresentation({
          originLabel,
          message,
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
    : undefined;

  return { prefix, suffix, presentationBuilder };
}

export function shouldApplyCrossContextMarker(action: ChannelMessageActionName): boolean {
  return resolveChannelMessageActionFacts(action)?.crossContext === "marker";
}

export function applyCrossContextDecoration(params: {
  message: string;
  decoration: CrossContextDecoration;
  preferPresentation: boolean;
}): {
  message: string;
  presentation?: MessagePresentation;
} {
  const buildPresentation = params.decoration.presentationBuilder;
  if (params.preferPresentation && buildPresentation) {
    return {
      message: params.message,
      presentation: buildPresentation(params.message),
    };
  }
  return { message: `${params.decoration.prefix}${params.message}${params.decoration.suffix}` };
}
