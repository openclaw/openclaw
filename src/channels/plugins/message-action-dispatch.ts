/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.public.js";

const trustedRequesterChannelManagementActions = new Set<ChannelMessageActionName>([
  "emoji-upload",
  "sticker-upload",
  "role-add",
  "role-remove",
  "channel-create",
  "channel-edit",
  "channel-delete",
  "channel-move",
  "category-create",
  "category-edit",
  "category-delete",
  "event-create",
  "timeout",
  "kick",
  "ban",
]);

function normalizeMessageActionChannel(raw?: string | null): string | undefined {
  return normalizeChannelId(raw) ?? normalizeOptionalLowercaseString(raw) ?? undefined;
}

function resolveProtectedActionCurrentProvider(
  ctx: ChannelMessageActionContext,
): string | undefined {
  if (!trustedRequesterChannelManagementActions.has(ctx.action)) {
    return undefined;
  }
  return normalizeMessageActionChannel(ctx.toolContext?.currentChannelProvider);
}

/**
 * Runs a channel message action if the target plugin supports it.
 */
export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) {
    return null;
  }

  // Canonical channel-management actions mutate guild/channel state. Keep them
  // fail-closed for same-channel tool turns even if a plugin omits the hook.
  const protectedActionCurrentProvider = resolveProtectedActionCurrentProvider(ctx);
  if (
    protectedActionCurrentProvider &&
    protectedActionCurrentProvider !== normalizeMessageActionChannel(ctx.channel)
  ) {
    throw new Error(
      `Trusted sender identity for ${ctx.channel}:${ctx.action} must come from ${ctx.channel}, not ${protectedActionCurrentProvider}.`,
    );
  }
  const pluginRequiresTrustedSender = Boolean(
    plugin.actions.requiresTrustedRequesterSender?.({
      action: ctx.action,
      toolContext: ctx.toolContext,
    }),
  );
  const requiresTrustedSender =
    pluginRequiresTrustedSender || Boolean(protectedActionCurrentProvider);
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the plugin without it.
  if (requiresTrustedSender && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await plugin.actions.handleAction(ctx);
}
