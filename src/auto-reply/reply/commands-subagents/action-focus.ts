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
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isTelegramSurface,
  resolveChannelAccountId,
  resolveFocusTargetSession,
  resolveTelegramConversationId,
  stopWithText,
} from "./shared.js";
import { resolveCommandSurfaceChannel } from "../channel-context.js";

type FocusBindingContext = {
  channel: "telegram";
  accountId: string;
  conversationId: string;
  placement: "current";
  labelNoun: "conversation";
};

function resolveFocusBindingContext(
  params: SubagentsCommandContext["params"],
): FocusBindingContext | null {
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
  if (channel !== "telegram") {
    return stopWithText("⚠️ /focus is only available on Telegram.");
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
    return stopWithText(`⚠️ Telegram conversation bindings are unavailable for this account.`);
  }

  const focusTarget = await resolveFocusTargetSession({ runs, token });
  if (!focusTarget) {
    return stopWithText(`⚠️ Unable to resolve focus target: ${token}`);
  }

  const bindingContext = resolveFocusBindingContext(params);
  if (!bindingContext) {
    return stopWithText(
      "⚠️ /focus on Telegram requires a topic context in groups, or a direct-message conversation.",
    );
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

  const actionText = `bound this ${bindingContext.labelNoun} to ${binding.targetSessionKey}`;
  return stopWithText(`✅ ${actionText} (${focusTarget.targetKind}).`);
}
