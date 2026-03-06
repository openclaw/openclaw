import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel, sortSubagentRuns } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
  stopWithText,
} from "./shared.js";

function formatConversationBindingText(params: {
  channel: string;
  conversationId: string;
}): string {
  if (params.channel === "discord") {
    return `thread:${params.conversationId}`;
  }
  if (params.channel === "telegram") {
    return `conversation:${params.conversationId}`;
  }
  return `binding:${params.conversationId}`;
}

export function handleSubagentsAgentsAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, requesterKey, runs } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  const accountId = resolveChannelAccountId(params);
  const bindingService = getSessionBindingService();
  const bindingsBySession = new Map<string, ReturnType<typeof bindingService.listBySession>>();

  const resolveSessionBindings = (sessionKey: string) => {
    const cached = bindingsBySession.get(sessionKey);
    if (cached) {
      return cached;
    }
    const resolved = bindingService
      .listBySession(sessionKey)
      .filter(
        (entry) =>
          entry.status === "active" &&
          entry.conversation.channel === channel &&
          entry.conversation.accountId === accountId,
      );
    bindingsBySession.set(sessionKey, resolved);
    return resolved;
  };

  const visibleRuns = sortSubagentRuns(runs).filter((entry) => {
    if (!entry.endedAt) {
      return true;
    }
    return resolveSessionBindings(entry.childSessionKey).length > 0;
  });

  const lines = ["agents:", "-----"];
  if (visibleRuns.length === 0) {
    lines.push("(none)");
  } else {
    let index = 1;
    for (const entry of visibleRuns) {
      const binding = resolveSessionBindings(entry.childSessionKey)[0];
      const bindingText = binding
        ? formatConversationBindingText({
            channel,
            conversationId: binding.conversation.conversationId,
          })
        : channel === "discord" || channel === "telegram"
          ? "unbound"
          : "bindings available on discord/telegram";
      lines.push(`${index}. ${formatRunLabel(entry)} (${bindingText})`);
      index += 1;
    }
  }

  const requesterBindings = resolveSessionBindings(requesterKey).filter(
    (entry) => entry.targetKind === "session",
  );
  if (requesterBindings.length > 0) {
    lines.push("", "acp/session bindings:", "-----");
    for (const binding of requesterBindings) {
      const label =
        typeof binding.metadata?.label === "string" && binding.metadata.label.trim()
          ? binding.metadata.label.trim()
          : binding.targetSessionKey;
      lines.push(
        `- ${label} (${formatConversationBindingText({
          channel,
          conversationId: binding.conversation.conversationId,
        })}, session:${binding.targetSessionKey})`,
      );
    }
  }

  return stopWithText(lines.join("\n"));
}
