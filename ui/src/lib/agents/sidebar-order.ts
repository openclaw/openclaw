import { moveArrayEntry, type ArrayDropPosition } from "../array-order.ts";

/** Invalid values are ignored; missing agents remain in the saved preference. */
export function normalizeSidebarAgentOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [
    ...new Set(
      value
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim()),
    ),
  ];
}

export function orderSidebarAgents<T extends { id: string }>(
  agents: readonly T[],
  order: readonly string[],
): T[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const listed = new Set(order);
  return [
    ...order.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    ...agents.filter((agent) => !listed.has(agent.id)),
  ];
}

export function moveSidebarAgent(
  saved: readonly string[],
  visible: readonly string[],
  source: string,
  target: string,
  position: ArrayDropPosition,
): string[] {
  // Append new agents, but never discard IDs absent from a partial roster.
  const order = [...new Set([...saved, ...visible])];
  return moveArrayEntry(order, source, target, position);
}
