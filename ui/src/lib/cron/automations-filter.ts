import { createSignal } from "solid-js";
import type {
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
  CronRunStatus,
  CronSortDir,
} from "../../api/types.ts";

export type AutomationsFilter = {
  /** One agent's automations; null is every agent, and unset follows the selected agent. */
  agentId?: string | null;
  status: "all" | "active" | "paused";
  scheduleKind: CronJobsScheduleKindFilter;
  lastRun: "all" | CronRunStatus | "unknown";
  trigger: CronJobsTriggerFilter;
  sort: "name" | "nextRunAtMs" | "updatedAtMs";
  sortDir: CronSortDir;
};

export const DEFAULT_AUTOMATIONS_FILTER: AutomationsFilter = {
  status: "all",
  scheduleKind: "all",
  lastRun: "all",
  trigger: "all",
  sort: "name",
  sortDir: "asc",
};

// The sidebar's filter for this tab, set from its header and read by its list.
const [automationsFilter, setAutomationsFilter] = createSignal(DEFAULT_AUTOMATIONS_FILTER);
export { automationsFilter, setAutomationsFilter };

/** Whether the Automations sidebar filter differs from its defaults. */
export function automationsFiltered(): boolean {
  const filter = automationsFilter();
  return (
    filter.agentId !== undefined ||
    filter.status !== DEFAULT_AUTOMATIONS_FILTER.status ||
    filter.scheduleKind !== DEFAULT_AUTOMATIONS_FILTER.scheduleKind ||
    filter.lastRun !== DEFAULT_AUTOMATIONS_FILTER.lastRun ||
    filter.trigger !== DEFAULT_AUTOMATIONS_FILTER.trigger ||
    filter.sort !== DEFAULT_AUTOMATIONS_FILTER.sort ||
    filter.sortDir !== DEFAULT_AUTOMATIONS_FILTER.sortDir
  );
}
