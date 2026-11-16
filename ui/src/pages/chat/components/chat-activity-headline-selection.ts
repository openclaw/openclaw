import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { addressedSession, spawnedSubagentLabel } from "../chat-spawned-subagent.ts";

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
  /** The pane's subagents; they name the sessions a call addresses by key. */
  subagentSessions?: readonly GatewaySessionRow[],
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
  const cards = callId ? [...preparedByCard.keys()].filter((card) => card.callId === callId) : [];
  let subagentLabel: string | undefined;
  let addressed: ReturnType<typeof addressedSession>;
  for (const card of cards) {
    subagentLabel ??= spawnedSubagentLabel(card);
    // A session addressed by key is named, never shown as its key's short suffix.
    addressed ??= addressedSession(card, subagentSessions);
  }
  return operation.title.trim()
    ? {
        key: operation.toolCallId ?? operation.itemId,
        // Purpose and outcome are separate: uncertainty must not replace known intent.
        title:
          subagentLabel ??
          (addressed ? (addressed.name ?? operation.title) : undefined) ??
          operation.meta ??
          (operation.status && operation.title === resolveToolDisplayIdentity(operation.name).label
            ? ""
            : operation.title),
        name: operation.name,
        commandBearing: operation.commandBearing,
        status: urgent ? status : operation.status,
      }
    : undefined;
}
