import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import { getChannelPlugin, normalizeChannelId } from "../../../channels/plugins/index.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { resolveChannelAccountId, resolveCommandSurfaceChannel } from "../channel-context.js";
import { stopWithText } from "../commands-subagents/core.js";
import type { CommandHandlerResult } from "../commands-types.js";
import type { SubagentsRequesterContext } from "../commands-subagents-types.js";

const RECENT_WINDOW_MINUTES = 30;

function formatConversationBindingText(params: { conversationId: string }): string {
  return `binding:${params.conversationId}`;
}

function supportsConversationBindings(channel: string): boolean {
  const channelId = normalizeChannelId(channel);
  if (!channelId) {
    return false;
  }
  return (
    getChannelPlugin(channelId)?.conversationBindings?.supportsCurrentConversationBinding === true
  );
}

function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = entry.label?.trim() || entry.task?.trim() || "";
  return raw || fallback;
}

function formatRunLabel(entry: SubagentRunRecord, options?: { maxLength?: number }) {
  const raw = resolveSubagentLabel(entry);
  const maxLength = options?.maxLength ?? 72;
  if (!Number.isFinite(maxLength) || maxLength <= 0 || raw.length <= maxLength) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sortSubagentRuns(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

export function handleSubagentsAgentsAction(ctx: SubagentsRequesterContext): CommandHandlerResult {
  const { params, requesterKey, runs } = ctx;
  const channel = resolveCommandSurfaceChannel(params);
  const accountId = resolveChannelAccountId(params);
  const requesterAgentId = params.agentId ?? parseAgentSessionKey(requesterKey)?.agentId ?? "main";
  const currentConversationBindingsSupported = supportsConversationBindings(channel);
  const bindingService = getSessionBindingService();
  const bindingsBySession = new Map<string, ReturnType<typeof bindingService.listBySession>>();
  const runsMap = new Map(runs.map((entry) => [entry.runId, entry] as const));
  const countPendingDescendants = (sessionKey: string) =>
    Math.max(0, countPendingDescendantRunsFromRuns(runsMap, sessionKey));

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
      (entry) => !entry.endedAt || countPendingDescendants(entry.childSessionKey) > 0,
    ),
    ...dedupedRuns.filter(
      (entry) =>
        entry.endedAt &&
        countPendingDescendants(entry.childSessionKey) === 0 &&
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
      countPendingDescendants(entry.childSessionKey) > 0 ||
      resolveSessionBindings(entry.childSessionKey).length > 0;
    if (!visible) {
      continue;
    }
    visibleRuns.push(entry);
  }

  const lines = [
    `Agent: ${requesterAgentId}`,
    ...params.workspaceDir ? [`Workspace: ${params.workspaceDir}`] : [],
    "",
    "agents:",
    "-----",
  ];
  if (visibleRuns.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of visibleRuns) {
      const binding = resolveSessionBindings(entry.childSessionKey)[0];
      const bindingText = binding
        ? formatConversationBindingText({
            conversationId: binding.conversation.conversationId,
          })
        : currentConversationBindingsSupported
          ? "unbound"
          : "bindings unavailable";
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
          conversationId: binding.conversation.conversationId,
        })}, session:${binding.targetSessionKey})`,
      );
    }
  }

  return stopWithText(lines.join("\n"));
}
