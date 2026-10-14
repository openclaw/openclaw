import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolDisplay } from "../../../lib/chat/tool-display.ts";
import { spawnedSubagentLabel } from "../chat-spawned-subagent.ts";

export type ActivityHeadline = Pick<AgentActivityItem, "name" | "commandBearing"> & {
  key: string;
  title: string;
  status: AgentActivityItem["status"];
};

/** Reuse recorded nesting for the purpose without replacing a child's urgent outcome. */
export function selectActivityHeadline(
  activity: readonly AgentActivityItem[],
  cardGroups: readonly ToolCallGroup<ToolCard>[],
  preparedByCard: ReadonlyMap<ToolCard, AgentActivityItem>,
): ActivityHeadline | undefined {
  const latest = activity.at(-1);
  const urgent = latest?.status === "failed" || latest?.status === "blocked";
  let operation = urgent
    ? latest
    : (activity.findLast((item) => item.status === "running") ?? latest);
  if (!operation) {
    return undefined;
  }
  const status = operation.status;
  for (const root of cardGroups) {
    const pending = [...root.children];
    for (const child of pending) {
      if (preparedByCard.get(child.card) === operation) {
        const parent = preparedByCard.get(root.card);
        if (parent && activity.includes(parent)) {
          operation = parent;
        }
      }
      pending.push(...child.children);
    }
  }
  // A launched subagent is named by its label; its other launch settings are
  // detail. A launch's call and result each carry a prepared item, so its card
  // is found by call, not by which of the two the headline holds.
  const callId = operation.toolCallId;
  let subagentLabel: string | undefined;
  if (callId) {
    for (const card of preparedByCard.keys()) {
      subagentLabel = card.callId === callId ? spawnedSubagentLabel(card) : undefined;
      if (subagentLabel) {
        break;
      }
    }
  }
  return operation.title.trim()
    ? {
        key: operation.toolCallId ?? operation.itemId,
        // Prepared metadata owns the purpose; never strip a localized tool prefix.
        title:
          (!operation.status ? operation.summary : undefined) ??
          subagentLabel ??
          operation.meta ??
          (operation.title === resolveToolDisplay({ name: operation.name }).label
            ? ""
            : operation.title),
        name: operation.name,
        commandBearing: operation.commandBearing,
        status: urgent ? status : operation.status,
      }
    : undefined;
}
