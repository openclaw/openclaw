/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
import { isTrustedRequesterChannelManagementAction } from "./message-action-protected-actions.js";
import type { ChannelMessageActionContext } from "./types.public.js";

function normalizeMessageActionChannel(raw?: string | null): string | undefined {
  return normalizeChannelId(raw) ?? normalizeOptionalLowercaseString(raw) ?? undefined;
}

function resolveProtectedActionCurrentProvider(
  ctx: ChannelMessageActionContext,
): string | undefined {
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

  // Canonical channel-management actions mutate guild/channel state. Require
  // a matching provider context so bare sender ids cannot be reused as proof.
  const isProtectedAction = isTrustedRequesterChannelManagementAction(ctx.action);
  const protectedActionCurrentProvider = isProtectedAction
    ? resolveProtectedActionCurrentProvider(ctx)
    : undefined;
  if (isProtectedAction) {
    if (!protectedActionCurrentProvider) {
      throw new Error(
        `Current channel provider context is required for ${ctx.channel}:${ctx.action} before trusted sender identity can be accepted.`,
      );
    }
    if (protectedActionCurrentProvider !== normalizeMessageActionChannel(ctx.channel)) {
      throw new Error(
        `Trusted sender identity for ${ctx.channel}:${ctx.action} must come from ${ctx.channel}, not ${protectedActionCurrentProvider}.`,
      );
    }
  }
  const pluginRequiresTrustedSender = Boolean(
    plugin.actions.requiresTrustedRequesterSender?.({
      action: ctx.action,
      toolContext: ctx.toolContext,
    }),
  );
  const requiresTrustedSender = pluginRequiresTrustedSender || isProtectedAction;
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
