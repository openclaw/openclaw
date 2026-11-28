import type { GatewayAgentRow } from "../../api/types.ts";
import { normalizeAgentId } from "../sessions/session-key.ts";

export type AgentSwitcherOrderParams = {
  /** The agent being created right now; it stays first while creation is pending. */
  pendingAgent?: GatewayAgentRow;
  /** The agent created most recently in this browser; it stays first until another one is. */
  recentlyCreatedAgentId?: string;
  /** Agents pinned in the sidebar roster, in the operator's pin order. */
  pinnedAgentIds?: readonly string[];
};

const UNPINNED = Number.MAX_SAFE_INTEGER;

/**
 * Orders the agent switcher rows: the agent being created or just created first,
 * then the agents pinned in the roster (in pin order), then everyone else in
 * roster order. Agents pinned but missing from the roster are ignored.
 */
export function orderAgentSwitcherRows(
  agents: readonly GatewayAgentRow[],
  params: AgentSwitcherOrderParams,
): GatewayAgentRow[] {
  const pending = params.pendingAgent;
  const rows = pending
    ? [pending, ...agents.filter((agent) => normalizeAgentId(agent.id) !== pending.id)]
    : [...agents];
  const firstId = pending?.id ?? params.recentlyCreatedAgentId;
  const pinRank = new Map<string, number>();
  for (const [index, id] of (params.pinnedAgentIds ?? []).entries()) {
    const key = normalizeAgentId(id);
    if (!pinRank.has(key)) {
      pinRank.set(key, index);
    }
  }
  const rank = (agent: GatewayAgentRow) => pinRank.get(normalizeAgentId(agent.id)) ?? UNPINNED;
  return rows.toSorted((a, b) => {
    const created = Number(b.id === firstId) - Number(a.id === firstId);
    return created !== 0 ? created : rank(a) - rank(b);
  });
}
