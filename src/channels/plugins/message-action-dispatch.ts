/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { normalizeOptionalAccountId, normalizeAccountId } from "../../routing/account-id.js";
import {
  normalizeConversationReadInvocationOrigin,
  supportsConversationReadPolicyV1,
} from "./conversation-read-origin.js";
import { getChannelPlugin } from "./index.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "./types.js";

const LEGACY_CONVERSATION_READ_ACTIONS = new Set<ChannelMessageActionName>([
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

function addTargetCandidates(params: {
  candidates: Set<string>;
  value: unknown;
  channel: string;
  plugin: ChannelPlugin;
}): void {
  if (typeof params.value !== "string") {
    return;
  }
  const value = params.value.trim();
  if (!value) {
    return;
  }
  const addWithProviderNormalization = (candidate: string) => {
    params.candidates.add(candidate);
    try {
      const normalized = params.plugin.messaging?.normalizeTarget?.(candidate)?.trim();
      if (normalized) {
        params.candidates.add(normalized);
      }
    } catch {
      // Legacy fallback must remain provider-I/O-free and fail closed on invalid targets.
    }
  };
  addWithProviderNormalization(value);
  const providerPrefixPattern = new RegExp(
    `^${params.channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`,
    "i",
  );
  const withoutProvider = value.replace(providerPrefixPattern, "").trim();
  if (withoutProvider && withoutProvider !== value) {
    addWithProviderNormalization(withoutProvider);
  }
}

function hasMatchingLegacyAccountContext(ctx: ChannelMessageActionContext): boolean {
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

function hasMatchingLegacyProviderContext(ctx: ChannelMessageActionContext): boolean {
  const currentProvider = ctx.toolContext?.currentChannelProvider?.trim().toLowerCase();
  return Boolean(currentProvider && currentProvider === ctx.channel.trim().toLowerCase());
}

function isExactLegacyCurrentConversation(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
}): boolean {
  if (
    !hasMatchingLegacyProviderContext(params.ctx) ||
    !hasMatchingLegacyAccountContext(params.ctx)
  ) {
    return false;
  }
  const requestedTargets = new Set<string>();
  for (const key of ["target", "to", "channelId", "roomId", "chatId"]) {
    addTargetCandidates({
      candidates: requestedTargets,
      value: params.ctx.params[key],
      channel: params.ctx.channel,
      plugin: params.plugin,
    });
  }
  if (requestedTargets.size === 0) {
    return false;
  }
  const currentTargets = new Set<string>();
  for (const value of [
    params.ctx.toolContext?.currentChannelId,
    params.ctx.toolContext?.currentMessagingTarget,
  ]) {
    addTargetCandidates({
      candidates: currentTargets,
      value,
      channel: params.ctx.channel,
      plugin: params.plugin,
    });
  }
  return Array.from(requestedTargets).some((candidate) => currentTargets.has(candidate));
}

function assertLegacyConversationReadAllowed(params: {
  ctx: ChannelMessageActionContext;
  plugin: ChannelPlugin;
}): void {
  if (
    normalizeConversationReadInvocationOrigin(params.ctx.conversationReadOrigin) ===
      "direct-operator" ||
    supportsConversationReadPolicyV1(params.plugin.actions?.conversationReadPolicy) ||
    !LEGACY_CONVERSATION_READ_ACTIONS.has(params.ctx.action)
  ) {
    return;
  }
  if (isExactLegacyCurrentConversation(params)) {
    return;
  }
  throw new Error(
    `Delegated ${params.ctx.channel}:${params.ctx.action} requires a current conversation on this plugin version.`,
  );
}

function requiresTrustedRequesterSender(ctx: ChannelMessageActionContext): boolean {
  const plugin = getChannelPlugin(ctx.channel);
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
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the plugin without it.
  if (requiresTrustedRequesterSender(ctx) && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) {
    return null;
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  // Older channel plugins predate the provider-I/O-safe read-policy contract.
  // Keep exact current-conversation reads working, but reject unprovable or
  // cross-conversation delegated reads before entering plugin code.
  assertLegacyConversationReadAllowed({ ctx, plugin });
  return await plugin.actions.handleAction(ctx);
}
