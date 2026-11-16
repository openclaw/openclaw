import { createSignal } from "solid-js";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import type { DashboardsDisplay } from "../app/settings-contract.ts";
import { normalizeAgentLabel } from "./agents/display.ts";
import type { SessionCreatedActor } from "./session-owner.ts";
import { normalizeAgentId } from "./sessions/session-key.ts";

export type DashboardsFilter = {
  /** An author's actor id, or null for every author. */
  authorId: string | null;
  sort: DashboardsDisplay["sort"];
  group: DashboardsDisplay["group"];
};

export const DEFAULT_DASHBOARDS_FILTER: DashboardsFilter = {
  authorId: null,
  sort: "updated",
  group: "none",
};

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

const DAY_MS = 24 * 60 * 60 * 1000;

/** The "Last updated" group a dashboard falls in, as the gallery and the sidebar group them. */
export function dashboardUpdatedGroup(updatedAt: number | undefined): "today" | "week" | "earlier" {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const time = updatedAt ?? 0;
  return time >= today.getTime()
    ? "today"
    : time >= today.getTime() - 6 * DAY_MS
      ? "week"
      : "earlier";
}

export const DASHBOARD_UPDATED_GROUP_LABELS = {
  today: "dashboardsPage.groupToday",
  week: "dashboardsPage.groupThisWeek",
  earlier: "dashboardsPage.groupEarlier",
} as const;
