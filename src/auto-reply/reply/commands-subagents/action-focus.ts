import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import { readAcpSessionEntry } from "../../../acp/runtime/session-meta.js";
import {
  resolveDiscordThreadBindingSessionTtlMs,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../discord/monitor/thread-bindings.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  resolveDiscordAccountId,
  resolveDiscordChannelIdForFocus,
  resolveFocusTargetSession,
  stopWithText,
} from "./shared.js";

export async function handleSubagentsFocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, runs, restTokens } = ctx;
  if (!isDiscordSurface(params)) {
    return stopWithText("⚠️ /focus is only available on Discord.");
  }

  const token = restTokens.join(" ").trim();
  if (!token) {
    return stopWithText("Usage: /focus <subagent-label|session-key|session-id|session-label>");
  }

  const accountId = resolveDiscordAccountId(params);
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: "discord",
    accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return stopWithText("⚠️ Discord thread bindings are unavailable for this account.");
  }

  const focusTarget = await resolveFocusTargetSession({ runs, token });
  if (!focusTarget) {
    return stopWithText(`⚠️ Unable to resolve focus target: ${token}`);
  }

  const currentThreadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  const parentChannelId = currentThreadId ? undefined : resolveDiscordChannelIdForFocus(params);
  if (!currentThreadId && !parentChannelId) {
    return stopWithText("⚠️ Could not resolve a Discord channel for /focus.");
  }

  const senderId = params.command.senderId?.trim() || "";
  if (currentThreadId) {
    const existingBinding = bindingService.resolveByConversation({
      channel: "discord",
      accountId,
      conversationId: currentThreadId,
    });
    const boundBy =
      typeof existingBinding?.metadata?.boundBy === "string"
        ? existingBinding.metadata.boundBy.trim()
        : "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      return stopWithText(`⚠️ Only ${boundBy} can refocus this thread.`);
    }
  }

  const label = focusTarget.label || token;
  const acpMeta =
    focusTarget.targetKind === "acp"
      ? readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: focusTarget.targetSessionKey,
        })?.acp
      : undefined;
  const placement = currentThreadId ? "current" : "child";
  if (!capabilities.placements.includes(placement)) {
    return stopWithText("⚠️ Discord thread bindings are unavailable for this account.");
  }
  const conversationId = currentThreadId || parentChannelId;
  if (!conversationId) {
    return stopWithText("⚠️ Could not resolve a Discord channel for /focus.");
  }

  let binding;
  try {
    binding = await bindingService.bind({
      targetSessionKey: focusTarget.targetSessionKey,
      targetKind: focusTarget.targetKind === "acp" ? "session" : "subagent",
      conversation: {
        channel: "discord",
        accountId,
        conversationId,
      },
      placement,
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
          sessionTtlMs: resolveDiscordThreadBindingSessionTtlMs({
            cfg: params.cfg,
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
    return stopWithText("⚠️ Failed to bind a Discord thread to the target session.");
  }

  const actionText = currentThreadId
    ? `bound this thread to ${binding.targetSessionKey}`
    : `created thread ${binding.conversation.conversationId} and bound it to ${binding.targetSessionKey}`;
  return stopWithText(`✅ ${actionText} (${focusTarget.targetKind}).`);
}
