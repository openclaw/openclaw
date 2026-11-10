import { USER_PREFS_VALUE_BYTES } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.ts";
import { moveArrayEntry, type ArrayDropPosition } from "../array-order.ts";

/** Presentation only: unlisted agents keep the Gateway's relative order. */
export function orderSidebarAgents<T extends { id: string }>(
  agents: readonly T[],
  savedOrder: readonly string[],
): T[] {
  const remaining = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered: T[] = [];
  for (const id of savedOrder) {
    const agent = remaining.get(id);
    if (agent) {
      ordered.push(agent);
      remaining.delete(id);
    }
  }
  return [...ordered, ...remaining.values()];
}

export function moveSidebarAgent(
  savedOrder: readonly string[],
  currentIds: readonly string[],
  source: string,
  target: string,
  position: ArrayDropPosition,
): string[] | null {
  if (source === target || !currentIds.includes(source) || !currentIds.includes(target)) {
    return [...savedOrder];
  }
  // Keep unavailable saved IDs: a temporary access/connection change is not deletion.
  const order = [...new Set([...savedOrder, ...currentIds])];
  // Canonical IDs are ASCII. Reject the whole edit instead of saving a truncated move.
  if (JSON.stringify(order).length > USER_PREFS_VALUE_BYTES) {
    return null;
  }
  return moveArrayEntry(order, source, target, position);
}
