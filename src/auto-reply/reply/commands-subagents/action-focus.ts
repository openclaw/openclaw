import type { CommandHandlerResult } from "../commands-types.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import { readAcpSessionEntry } from "../../../acp/runtime/session-meta.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../../channels/thread-bindings-policy.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  isTelegramSurface,
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
  resolveDiscordChannelIdForFocus,
  resolveFocusTargetSession,
  resolveTelegramConversationId,
  stopWithText,
} from "./shared.js";

type FocusBindingContext = {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;
  placement: "current" | "child";
  labelNoun: "thread" | "conversation";
};

function resolveFocusBindingContext(
  params: SubagentsCommandContext["params"],
): FocusBindingContext | null {
  if (isDiscordSurface(params)) {
    const currentThreadId =
      params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
    const parentChannelId = currentThreadId ? undefined : resolveDiscordChannelIdForFocus(params);
    const conversationId = currentThreadId || parentChannelId;
    if (!conversationId) {
      return null;
    }
    return {
      channel: "discord",
      accountId: resolveChannelAccountId(params),
      conversationId,
      placement: currentThreadId ? "current" : "child",
      labelNoun: "thread",
    };
  }
  if (isTelegramSurface(params)) {
    const conversationId = resolveTelegramConversationId(params);
    if (!conversationId) {
      return null;
    }
    return {
      channel: "telegram",
      accountId: resolveChannelAccountId(params),
      conversationId,
      placement: "current",
      labelNoun: "conversation",
    };
  }
  return null;
}

export async function handleSubagentsFocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, runs, restTokens } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  if (channel !== "discord" && channel !== "telegram") {
    return stopWithText("⚠️ /focus is only available on Discord and Telegram.");
  }

  const token = restTokens.join(" ").trim();
  if (!token) {
    return stopWithText("Usage: /focus <subagent-label|session-key|session-id|session-label>");
  }

  const accountId = resolveChannelAccountId(params);
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel,
    accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    const label = channel === "discord" ? "Discord thread" : "Telegram conversation";
    return stopWithText(`⚠️ ${label} bindings are unavailable for this account.`);
  }

  const focusTarget = await resolveFocusTargetSession({ runs, token });
  if (!focusTarget) {
    return stopWithText(`⚠️ Unable to resolve focus target: ${token}`);
  }

  const bindingContext = resolveFocusBindingContext(params);
  if (!bindingContext) {
    if (channel === "telegram") {
      return stopWithText(
        "⚠️ /focus on Telegram requires a topic context in groups, or a direct-message conversation.",
      );
    }
    return stopWithText("⚠️ Could not resolve a Discord channel for /focus.");
  }

  const senderId = params.command.senderId?.trim() || "";
  const existingBinding = bindingService.resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
  });
  const boundBy =
    typeof existingBinding?.metadata?.boundBy === "string"
      ? existingBinding.metadata.boundBy.trim()
      : "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return stopWithText(`⚠️ Only ${boundBy} can refocus this ${bindingContext.labelNoun}.`);
  }

  const label = focusTarget.label || token;
  const acpMeta =
    focusTarget.targetKind === "acp"
      ? readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: focusTarget.targetSessionKey,
        })?.acp
      : undefined;
  if (!capabilities.placements.includes(bindingContext.placement)) {
    return stopWithText(`⚠️ ${channel} bindings are unavailable for this account.`);
  }

  let binding;
  try {
    binding = await bindingService.bind({
      targetSessionKey: focusTarget.targetSessionKey,
      targetKind: focusTarget.targetKind === "acp" ? "session" : "subagent",
      conversation: {
        channel: bindingContext.channel,
        accountId: bindingContext.accountId,
        conversationId: bindingContext.conversationId,
      },
      placement: bindingContext.placement,
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: focusTarget.agentId,
          label,
        }),
        agentId: focusTarget.agentId,
        label,
        boundBy: senderId || "unknown",
        introText: resolveThreadBindingIntroText({
          agentId: focusTarget.agentId,
          label,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: params.cfg,
            channel: bindingContext.channel,
            accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: params.cfg,
            channel: bindingContext.channel,
            accountId,
          }),
          sessionCwd: focusTarget.targetKind === "acp" ? resolveAcpSessionCwd(acpMeta) : undefined,
          sessionDetails:
            focusTarget.targetKind === "acp"
              ? resolveAcpThreadSessionDetailLines({
                  sessionKey: focusTarget.targetSessionKey,
                  meta: acpMeta,
                })
              : [],
        }),
      },
    });
  } catch {
    return stopWithText(
      `⚠️ Failed to bind this ${bindingContext.labelNoun} to the target session.`,
    );
  }

  const actionText =
    bindingContext.placement === "child"
      ? `created thread ${binding.conversation.conversationId} and bound it to ${binding.targetSessionKey}`
      : `bound this ${bindingContext.labelNoun} to ${binding.targetSessionKey}`;
  return stopWithText(`✅ ${actionText} (${focusTarget.targetKind}).`);
}
