import { normalizeChatType } from "../../../channels/chat-type.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { stopWithText } from "../commands-subagents/core.js";
import type { CommandHandlerResult } from "../commands-types.js";
import type { SubagentsRunsContext } from "../commands-subagents-types.js";
import { resolveConversationBindingContextFromAcpCommand } from "../conversation-binding-input.js";
import { resolveFocusTargetSession } from "./focus-target.js";

type FocusBindingContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  placement: "current" | "child";
};

async function resolveFocusBindingContext(
  params: SubagentsRunsContext["params"],
): Promise<FocusBindingContext | null> {
  const bindingContext = resolveConversationBindingContextFromAcpCommand(params);
  if (!bindingContext) {
    return null;
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  const { resolveThreadBindingPlacementForCurrentContext } = await import(
    "../../../channels/thread-bindings-policy.js"
  );
  return {
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
    placement:
      chatType === "direct"
        ? "current"
        : resolveThreadBindingPlacementForCurrentContext({
            channel: bindingContext.channel,
            threadId: bindingContext.threadId || undefined,
          }),
  };
}

export async function handleSubagentsFocusAction(
  ctx: SubagentsRunsContext,
): Promise<CommandHandlerResult> {
  const { params, runs, restTokens } = ctx;
  const token = restTokens.join(" ").trim();
  if (!token) {
    return stopWithText("Usage: /focus <subagent-label|session-key|session-id|session-label>");
  }

  const bindingContext = await resolveFocusBindingContext(params);
  if (!bindingContext) {
    return stopWithText("⚠️ /focus must be run inside a bindable conversation.");
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return stopWithText("⚠️ Conversation bindings are unavailable for this account.");
  }

  const focusTarget = await resolveFocusTargetSession({ runs, token });
  if (!focusTarget) {
    return stopWithText(`⚠️ Unable to resolve focus target: ${token}`);
  }

  if (bindingContext.placement === "child") {
    const {
      formatThreadBindingDisabledError,
      formatThreadBindingSpawnDisabledError,
      resolveThreadBindingSpawnPolicy,
    } = await import("../../../channels/thread-bindings-policy.js");
    const spawnPolicy = resolveThreadBindingSpawnPolicy({
      cfg: params.cfg,
      channel: bindingContext.channel,
      accountId: bindingContext.accountId,
      kind: "subagent",
    });
    if (!spawnPolicy.enabled) {
      return stopWithText(
        `⚠️ ${formatThreadBindingDisabledError({
          channel: spawnPolicy.channel,
          accountId: spawnPolicy.accountId,
          kind: "subagent",
        })}`,
      );
    }
    if (bindingContext.placement === "child" && !spawnPolicy.spawnEnabled) {
      return stopWithText(
        `⚠️ ${formatThreadBindingSpawnDisabledError({
          channel: spawnPolicy.channel,
          accountId: spawnPolicy.accountId,
          kind: "subagent",
        })}`,
      );
    }
  }

  const senderId = params.command.senderId?.trim() || "";
  const existingBinding = bindingService.resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId &&
    bindingContext.parentConversationId !== bindingContext.conversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  const boundBy =
    typeof existingBinding?.metadata?.boundBy === "string"
      ? existingBinding.metadata.boundBy.trim()
      : "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return stopWithText(`⚠️ Only ${boundBy} can refocus this conversation.`);
  }

  const label = focusTarget.label || token;
  const accountId = bindingContext.accountId;
  const acpMeta =
    focusTarget.targetKind === "acp"
      ? (
          await import("../../../acp/runtime/session-meta.js")
        ).readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: focusTarget.targetSessionKey,
        })?.acp
      : undefined;
  if (!capabilities.placements.includes(bindingContext.placement)) {
    return stopWithText("⚠️ Conversation bindings are unavailable for this account.");
  }

  let binding;
  try {
    const {
      resolveThreadBindingIntroText,
      resolveThreadBindingThreadName,
    } = await import("../../../channels/thread-bindings-messages.js");
    const {
      resolveThreadBindingIdleTimeoutMsForChannel,
      resolveThreadBindingMaxAgeMsForChannel,
    } = await import("../../../channels/thread-bindings-policy.js");
    const { resolveAcpSessionCwd, resolveAcpThreadSessionDetailLines } = await import(
      "../../../acp/runtime/session-identifiers.js"
    );
    binding = await bindingService.bind({
      targetSessionKey: focusTarget.targetSessionKey,
      targetKind: focusTarget.targetKind === "acp" ? "session" : "subagent",
      conversation: {
        channel: bindingContext.channel,
        accountId: bindingContext.accountId,
        conversationId: bindingContext.conversationId,
        ...(bindingContext.parentConversationId &&
        bindingContext.parentConversationId !== bindingContext.conversationId
          ? { parentConversationId: bindingContext.parentConversationId }
          : {}),
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
    return stopWithText("⚠️ Failed to bind this conversation to the target session.");
  }

  const actionText =
    bindingContext.placement === "child"
      ? `created child conversation ${binding.conversation.conversationId} and bound it to ${binding.targetSessionKey}`
      : `bound this conversation to ${binding.targetSessionKey}`;
  return stopWithText(`✅ ${actionText} (${focusTarget.targetKind}).`);
}
