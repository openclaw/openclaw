import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import {
  automationsFilter,
  DEFAULT_AUTOMATIONS_FILTER,
  setAutomationsFilter,
  type AutomationsFilter,
} from "../lib/cron/automations-filter.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { SidebarSectionFilter } from "./app-sidebar-section-filter.tsx";

registerEnglishCatalog(registerCronEnglish);

const STATUSES = ["all", "active", "paused"] as const;
const LAST_RUNS = ["all", "ok", "error"] as const;
const SORTS = ["name", "nextRunAtMs", "updatedAtMs"] as const;

/** The Automations sidebar filter: status, last activity and order. */
export function SidebarAutomationsFilter() {
  const set = (patch: Partial<AutomationsFilter>) =>
    setAutomationsFilter({ ...automationsFilter(), ...patch });
  const filtered = () => {
    const filter = automationsFilter();
    return (
      filter.status !== DEFAULT_AUTOMATIONS_FILTER.status ||
      filter.lastRun !== DEFAULT_AUTOMATIONS_FILTER.lastRun ||
      filter.sort !== DEFAULT_AUTOMATIONS_FILTER.sort
    );
  };
  return (
    <SidebarSectionFilter
      label={t("cron.list.filters")}
      filtered={filtered()}
      resetLabel={t("cron.jobs.reset")}
      onReset={() => setAutomationsFilter(DEFAULT_AUTOMATIONS_FILTER)}
      pickers={[
        {
          id: "sidebar-automations-status",
          label: t("cron.runs.status"),
          value: automationsFilter().status,
          options: [
            { value: "all", label: t("cron.tabs.all") },
            { value: "active", label: t("cron.tabs.active") },
            { value: "paused", label: t("cron.tabs.paused") },
          ],
          onChange: (value) => {
            const status = STATUSES.find((candidate) => candidate === value);
            if (status) {
              set({ status });
            }
          },
        },
        {
          id: "sidebar-automations-last-run",
          label: t("cron.jobs.lastRun"),
          value: automationsFilter().lastRun,
          options: [
            { value: "all", label: t("cron.jobs.all") },
            { value: "ok", label: t("cron.runs.runStatusOk") },
            { value: "error", label: t("cron.runs.runStatusError") },
          ],
          onChange: (value) => {
            const lastRun = LAST_RUNS.find((candidate) => candidate === value);
            if (lastRun) {
              set({ lastRun });
            }
          },
        },
        {
          id: "sidebar-automations-sort",
          label: t("cron.jobs.sort"),
          value: automationsFilter().sort,
          options: [
            { value: "name", label: t("cron.jobs.name") },
            { value: "nextRunAtMs", label: t("cron.jobs.nextRun") },
            { value: "updatedAtMs", label: t("cron.jobs.recentlyUpdated") },
          ],
          onChange: (value) => {
            const sort = SORTS.find((candidate) => candidate === value);
            if (sort) {
              set({ sort });
            }
          },
        },
      ]}
    />
  );
}
