import { createSignal } from "solid-js";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import { normalizeAgentLabel } from "./agents/display.ts";
import type { SessionCreatedActor } from "./session-owner.ts";
import { normalizeAgentId } from "./sessions/session-key.ts";

export type DashboardsFilter = {
  /** An author's actor id, or null for every author. */
  authorId: string | null;
  sort: "updated" | "title";
};

export const DEFAULT_DASHBOARDS_FILTER: DashboardsFilter = { authorId: null, sort: "updated" };

// The Dashboards sidebar's filter for this tab, set from its header and read by its list.
const [dashboardsFilter, setDashboardsFilter] = createSignal(DEFAULT_DASHBOARDS_FILTER);
export { dashboardsFilter, setDashboardsFilter };

/**
 * A dashboard's author, as the gallery and the sidebar show it: the creator, else the owner,
 * else the session's agent. An agent author without a label of its own reads as the agent's name.
 */
export function dashboardAuthor(
  row: GatewaySessionRow,
  fallbackAgentId: string,
  agents: AgentsListResult["agents"],
) {
  const actor = row.createdActor ?? row.owner?.actor;
  const id = actor?.id?.trim() || row.agentId?.trim() || fallbackAgentId;
  const agent =
    !actor?.id?.trim() || actor.type === "agent"
      ? agents.find((entry) => normalizeAgentId(entry.id) === normalizeAgentId(id))
      : undefined;
  const label = actor?.label?.trim() || (agent ? normalizeAgentLabel(agent) : id);
  // Without an actor id the author is the session's agent, drawn with its agent avatar.
  const avatar: SessionCreatedActor = actor?.id?.trim()
    ? actor
    : { type: "agent", id, label, identity: { type: "agent", id } };
  return { id, label, avatar };
}
