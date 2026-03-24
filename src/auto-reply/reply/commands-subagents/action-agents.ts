import { countPendingDescendantRuns } from "../../../agents/subagent-registry.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel, sortSubagentRuns } from "../subagents-utils.js";
import {
  RECENT_WINDOW_MINUTES,
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

  const dedupedRuns: typeof runs = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sortSubagentRuns(runs)) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    seenChildSessionKeys.add(entry.childSessionKey);
    dedupedRuns.push(entry);
  }

  const recentCutoff = Date.now() - RECENT_WINDOW_MINUTES * 60_000;
  const numericOrder = [
    ...dedupedRuns.filter(
      (entry) => !entry.endedAt || countPendingDescendantRuns(entry.childSessionKey) > 0,
    ),
    ...dedupedRuns.filter(
      (entry) =>
        entry.endedAt &&
        countPendingDescendantRuns(entry.childSessionKey) === 0 &&
        entry.endedAt >= recentCutoff,
    ),
  ];
  const indexByChildSessionKey = new Map(
    numericOrder.map((entry, idx) => [entry.childSessionKey, idx + 1] as const),
  );

  const visibleRuns: typeof dedupedRuns = [];
  for (const entry of dedupedRuns) {
    const visible =
      !entry.endedAt ||
      countPendingDescendantRuns(entry.childSessionKey) > 0 ||
      resolveSessionBindings(entry.childSessionKey).length > 0;
    if (!visible) {
      continue;
    }
    visibleRuns.push(entry);
  }

  const lines = ["agents:", "-----"];
  if (visibleRuns.length === 0) {
    lines.push("(none)");
  } else {
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
      const resolvedIndex = indexByChildSessionKey.get(entry.childSessionKey);
      const prefix = resolvedIndex ? `${resolvedIndex}.` : "-";
      lines.push(`${prefix} ${formatRunLabel(entry)} (${bindingText})`);
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
