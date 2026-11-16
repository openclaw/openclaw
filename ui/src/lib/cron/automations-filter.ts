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
