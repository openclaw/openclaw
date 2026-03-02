import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import {
  getChannelMessageAdapter,
  type CrossContextComponentsBuilder,
} from "./channel-adapters.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { formatTargetDisplay, lookupDirectoryDisplay } from "./target-resolver.js";

export type CrossContextDecoration = {
  prefix: string;
  suffix: string;
  componentsBuilder?: CrossContextComponentsBuilder;
};

const CONTEXT_GUARDED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "reply",
  "sendWithEffect",
  "sendAttachment",
  "thread-create",
  "thread-reply",
  "sticker",
]);

const CONTEXT_MARKER_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "reply",
  "sendWithEffect",
  "sendAttachment",
  "thread-reply",
  "sticker",
]);

/**
 * Extracts the destination target from action args regardless of action type.
 * Used by the read-only source guard, which must block ANY action targeting the source.
 */
function resolveActionTarget(params: Record<string, unknown>): string | undefined {
  if (typeof params.to === "string") {
    return params.to;
  }
  if (typeof params.channelId === "string") {
    return params.channelId;
  }
  return undefined;
}

/**
 * Extracts the destination target for cross-context policy checks.
 * Only resolves for send-family actions (CONTEXT_GUARDED_ACTIONS).
 */
function resolveContextGuardTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
): string | undefined {
  if (!CONTEXT_GUARDED_ACTIONS.has(action)) {
    return undefined;
  }
  return resolveActionTarget(params);
}

function normalizeTarget(channel: ChannelId, raw: string): string | undefined {
  return normalizeTargetForProvider(channel, raw) ?? raw.trim();
}

function isCrossContextTarget(params: {
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
}): boolean {
  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) {
    return false;
  }
  const normalizedTarget = normalizeTarget(params.channel, params.target);
  const normalizedCurrent = normalizeTarget(params.channel, currentTarget);
  if (!normalizedTarget || !normalizedCurrent) {
    return false;
  }
  return normalizedTarget !== normalizedCurrent;
}

export function enforceCrossContextPolicy(params: {
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): void {
  // Read-only source guard: runs for EVERY action, not just send-family.
  // If we have a read-only source and the action targets it, block unconditionally.
  const readOnlySource = params.toolContext?.readOnlySource;
  if (readOnlySource) {
    const readOnlySourceChannel =
      typeof readOnlySource.channel === "string" ? readOnlySource.channel.trim().toLowerCase() : "";
    const readOnlySourceTo = typeof readOnlySource.to === "string" ? readOnlySource.to.trim() : "";
    if (readOnlySourceChannel && readOnlySourceTo && readOnlySourceChannel === params.channel) {
      const actionTarget = resolveActionTarget(params.args);
      const normalizedSource = normalizeTarget(params.channel, readOnlySourceTo);
      const normalizedAction = actionTarget
        ? normalizeTarget(params.channel, actionTarget)
        : undefined;
      if (normalizedSource && normalizedAction && normalizedSource === normalizedAction) {
        const sourceAccountId = normalizeOptionalAccountId(readOnlySource.accountId);
        const targetAccountId = normalizeOptionalAccountId(params.accountId);
        const accountMatches =
          !sourceAccountId || !targetAccountId || sourceAccountId === targetAccountId;
        if (accountMatches) {
          throw new Error("Source channel is read-only; send to relay destination only.");
        }
      }
    }
  }

  // Cross-context policy: only applies to send-family actions.
  if (!CONTEXT_GUARDED_ACTIONS.has(params.action)) {
    return;
  }

  const target = resolveContextGuardTarget(params.action, params.args);

  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) {
    return;
  }

  if (params.cfg.tools?.message?.allowCrossContextSend) {
    return;
  }

  const currentProvider = params.toolContext?.currentChannelProvider;
  const allowWithinProvider =
    params.cfg.tools?.message?.crossContext?.allowWithinProvider !== false;
  const allowAcrossProviders =
    params.cfg.tools?.message?.crossContext?.allowAcrossProviders === true;

  if (currentProvider && currentProvider !== params.channel) {
    if (!allowAcrossProviders) {
      throw new Error(
        `Cross-context messaging denied: action=${params.action} target provider "${params.channel}" while bound to "${currentProvider}".`,
      );
    }
    return;
  }

  if (allowWithinProvider) {
    return;
  }

  if (!target) {
    return;
  }

  if (!isCrossContextTarget({ channel: params.channel, target, toolContext: params.toolContext })) {
    return;
  }

  throw new Error(
    `Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).`,
  );
}

export async function buildCrossContextDecoration(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
}): Promise<CrossContextDecoration | null> {
  if (!params.toolContext?.currentChannelId) {
    return null;
  }
  // Skip decoration for direct tool sends (agent composing, not forwarding)
  if (params.toolContext.skipCrossContextDecoration) {
    return null;
  }
  if (!isCrossContextTarget(params)) {
    return null;
  }

  const markerConfig = params.cfg.tools?.message?.crossContext?.marker;
  if (markerConfig?.enabled === false) {
    return null;
  }

  const currentName =
    (await lookupDirectoryDisplay({
      cfg: params.cfg,
      channel: params.channel,
      targetId: params.toolContext.currentChannelId,
      accountId: params.accountId ?? undefined,
    })) ?? params.toolContext.currentChannelId;
  // Don't force group formatting here; currentChannelId can be a DM or a group.
  const originLabel = formatTargetDisplay({
    channel: params.channel,
    target: params.toolContext.currentChannelId,
    display: currentName,
  });
  const prefixTemplate = markerConfig?.prefix ?? "[from {channel}] ";
  const suffixTemplate = markerConfig?.suffix ?? "";
  const prefix = prefixTemplate.replaceAll("{channel}", originLabel);
  const suffix = suffixTemplate.replaceAll("{channel}", originLabel);

  const adapter = getChannelMessageAdapter(params.channel);
  const componentsBuilder = adapter.supportsComponentsV2
    ? adapter.buildCrossContextComponents
      ? (message: string) =>
          adapter.buildCrossContextComponents!({
            originLabel,
            message,
            cfg: params.cfg,
            accountId: params.accountId ?? undefined,
          })
      : undefined
    : undefined;

  return { prefix, suffix, componentsBuilder };
}

export function shouldApplyCrossContextMarker(action: ChannelMessageActionName): boolean {
  return CONTEXT_MARKER_ACTIONS.has(action);
}

export function applyCrossContextDecoration(params: {
  message: string;
  decoration: CrossContextDecoration;
  preferComponents: boolean;
}): {
  message: string;
  componentsBuilder?: CrossContextComponentsBuilder;
  usedComponents: boolean;
} {
  const useComponents = params.preferComponents && params.decoration.componentsBuilder;
  if (useComponents) {
    return {
      message: params.message,
      componentsBuilder: params.decoration.componentsBuilder,
      usedComponents: true,
    };
  }
  const message = `${params.decoration.prefix}${params.message}${params.decoration.suffix}`;
  return { message, usedComponents: false };
}
