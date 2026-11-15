import { createSignal } from "solid-js";

export type AutomationsFilter = {
  /** One agent's automations; null is every agent, and unset follows the selected agent. */
  agentId?: string | null;
  status: "all" | "active" | "paused";
  lastRun: "all" | "ok" | "error";
  sort: "name" | "nextRunAtMs" | "updatedAtMs";
};

export const DEFAULT_AUTOMATIONS_FILTER: AutomationsFilter = {
  status: "all",
  lastRun: "all",
  sort: "name",
};

// The sidebar's filter for this tab, set from its header and read by its list.
const [automationsFilter, setAutomationsFilter] = createSignal(DEFAULT_AUTOMATIONS_FILTER);
export { automationsFilter, setAutomationsFilter };
