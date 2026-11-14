import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { addressedSession } from "../chat-spawned-subagent.ts";
import { resolveToolOperationLabel } from "./chat-tool-row-presentation.ts";

export type ActivityHeadline = Pick<AgentActivityItem, "name" | "commandBearing"> & {
  key: string;
  title: string;
  status: AgentActivityItem["status"];
};

/** Select the recorded operation; execution containers never replace a child's action. */
export function selectActivityHeadline(
  activity: readonly AgentActivityItem[],
  preparedByCard: ReadonlyMap<ToolCard, AgentActivityItem>,
  subagentSessions?: readonly GatewaySessionRow[],
): ActivityHeadline | undefined {
  const latest = activity.at(-1);
  const urgent = latest?.status === "failed" || latest?.status === "blocked";
  const operation = urgent
    ? latest
    : (activity.findLast((item) => item.status === "running") ?? latest);
  if (!operation) {
    return undefined;
  }
  const status = operation.status;
  // The latest prepared outcome owns the headline even when the raw card lags.
  const callId = operation.toolCallId;
  let operationLabel: string | undefined;
  if (callId) {
    for (const [card, recorded] of preparedByCard) {
      const addressed = addressedSession(card, subagentSessions);
      const toolName = unwrapToolCallForDisplay(card).name.trim().toLowerCase();
      operationLabel =
        recorded === operation
          ? addressed &&
            !addressed.name &&
            toolName !== "sessions_history" &&
            toolName !== "agents_wait"
            ? operation.title
            : resolveToolOperationLabel(
                card,
                operation.status === "completed" ? "succeeded" : (operation.status ?? "unknown"),
                addressed,
                operation.meta,
              )
          : undefined;
      if (operationLabel) {
        break;
      }
    }
  }
  return operation.title.trim()
    ? {
        key: operation.toolCallId ?? operation.itemId,
        title:
          operationLabel ??
          (operation.name === "exec" ? operation.meta : undefined) ??
          (operation.status && operation.title === resolveToolDisplayIdentity(operation.name).label
            ? ""
            : operation.title),
        name: operation.name,
        commandBearing: operation.commandBearing,
        status: urgent ? status : operation.status,
      }
    : undefined;
}
