import { createSignal } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { SessionCreatedActor } from "./session-owner.ts";

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
 * else the session's agent.
 */
export function dashboardAuthor(row: GatewaySessionRow, fallbackAgentId: string) {
  const actor = row.createdActor ?? row.owner?.actor;
  const id = actor?.id?.trim() || row.agentId?.trim() || fallbackAgentId;
  const label = actor?.label?.trim() || id;
  // Without an actor id the author is the session's agent, drawn with its agent avatar.
  const avatar: SessionCreatedActor = actor?.id?.trim()
    ? actor
    : { type: "agent", id, label, identity: { type: "agent", id } };
  return { id, label, avatar };
}
