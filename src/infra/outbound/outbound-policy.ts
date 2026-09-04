import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageToolsConfig } from "../../config/types.tools.js";
import type { MessagePresentation } from "../../interactive/payload.js";
import { MessageActionDeniedError } from "./message-action-denial.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { formatTargetDisplay, lookupDirectoryDisplay } from "./target-resolver.js";

export type CrossContextDecoration = {
  prefix: string;
  suffix: string;
  presentationBuilder?: (message: string) => MessagePresentation;
};

// All mutations are guarded, but markers only apply to outbound payloads that
// create new visible content. Existing-message edits/pins/deletes should not
// grow cross-context forwarding text.
const CONTEXT_MARKER_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "reply",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
  "thread-reply",
  "sticker",
]);

const CONTEXT_GUARDED_ACTIONS = new Set<ChannelMessageActionName>([
  ...CONTEXT_MARKER_ACTIONS,
  // A roll is a recipient-visible send addressed by `to`, so it must clear the same
  // cross-context check; without the entry the guard returns before comparing targets.
  // It stays out of the marker set: a roll carries no text for a marker to attach to.
  "dice",
  "poll-vote",
  "edit",
  "delete",
  "pin",
  "unpin",
  "thread-create",
  "topic-create",
  "topic-edit",
]);

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
  if (!CONTEXT_GUARDED_ACTIONS.has(params.action)) {
    return;
  }

  const messageConfig = resolveEffectiveMessageToolsConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  // Doctor moves the shipped allowCrossContextSend flag into this canonical policy.
  // Runtime must not keep a second legacy interpretation path here.
  const currentProvider = params.toolContext?.currentChannelProvider;
  const allowWithinProvider = messageConfig?.crossContext?.allowWithinProvider !== false;
  const allowAcrossProviders = messageConfig?.crossContext?.allowAcrossProviders !== false;

  // Provider mismatch is stronger than target mismatch; normalize targets only within one provider.
  if (currentProvider && currentProvider !== params.channel) {
    if (!allowAcrossProviders) {
      throw new MessageActionDeniedError(
        `Cross-context messaging denied: action=${params.action} target provider "${params.channel}" while bound to "${currentProvider}".`,
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
  let target: string | undefined;
  for (const key of targetKeys) {
    if (typeof params.args[key] === "string") {
      target = params.args[key];
      break;
    }
  }
  if (
    !target ||
    !isCrossContextTarget({ channel: params.channel, target, toolContext: params.toolContext })
  ) {
    return;
  }

  throw new MessageActionDeniedError(
    `Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).`,
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

  const markerConfig = resolveEffectiveMessageToolsConfig({
    cfg: params.cfg,
    agentId: params.agentId,
  })?.crossContext?.marker;
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
  return CONTEXT_MARKER_ACTIONS.has(action);
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
