import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../lib/agents/display.ts";
import {
  automationsFilter,
  DEFAULT_AUTOMATIONS_FILTER,
  setAutomationsFilter,
  type AutomationsFilter,
} from "../lib/cron/automations-filter.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { resolveSessionNavigationAgentId } from "../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  renderSidebarSectionFilterMenu,
  type SidebarSectionFilterPicker,
} from "./app-sidebar-section-filter.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";

registerEnglishCatalog(registerCronEnglish);

type Choice = Exclude<keyof AutomationsFilter, "agentId">;

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

/** One picker over a filter field, offering only that field's values. */
function choice<K extends Choice>(
  key: K,
  label: string,
  options: readonly { value: AutomationsFilter[K]; label: string }[],
): SidebarSectionFilterPicker {
  return {
    id: `sidebar-automations-${key}`,
    label,
    value: automationsFilter()[key],
    options,
    onChange: (value) => {
      const option = options.find((candidate) => candidate.value === value);
      if (option) {
        setAutomationsFilter({ ...automationsFilter(), [key]: option.value });
      }
    },
  };
}

/** The Automations sidebar filter: the choices the Automations table offered, applied to the list. */
export function renderSidebarAutomationsFilterMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
) {
  const context = host.sessionDataContext;
  // Unset follows the agent selected now; the sidebar list resolves it the same way.
  const agentValue = () => {
    const agentId = automationsFilter().agentId;
    return agentId === null
      ? ""
      : (agentId ?? (context ? resolveSessionNavigationAgentId(context) : ""));
  };
  const agents = () =>
    listSelectableAgents(context?.agents.state.agentsList?.agents ?? []).map((agent) => ({
      value: normalizeAgentId(agent.id),
      label: normalizeAgentLabel(agent),
    }));
  return renderSidebarSectionFilterMenu(menus, "automationsFilter", {
    label: t("cron.list.filters"),
    resetLabel: t("cron.jobs.reset"),
    filtered: automationsFiltered,
    onReset: () => setAutomationsFilter(DEFAULT_AUTOMATIONS_FILTER),
    pickers: () => [
      ...(agents().length > 1
        ? [
            {
              id: "sidebar-automations-agent",
              label: t("agentScope.label"),
              value: agentValue(),
              options: [{ value: "", label: t("agentScope.allAgents") }, ...agents()],
              onChange: (value: string) =>
                setAutomationsFilter({ ...automationsFilter(), agentId: value || null }),
            },
          ]
        : []),
      choice("status", t("cron.runs.status"), [
        { value: "all", label: t("cron.tabs.all") },
        { value: "active", label: t("cron.tabs.active") },
        { value: "paused", label: t("cron.tabs.paused") },
      ]),
      choice("scheduleKind", t("cron.jobs.schedule"), [
        { value: "all", label: t("cron.jobs.all") },
        { value: "at", label: t("cron.form.at") },
        { value: "every", label: t("cron.form.every") },
        { value: "cron", label: t("cron.form.cronOption") },
        { value: "event", label: t("cron.events.label") },
        { value: "on-exit", label: t("cron.form.repeatOnExit") },
        { value: "stream", label: t("cron.form.repeatStream") },
      ]),
      choice("lastRun", t("cron.jobs.lastRun"), [
        { value: "all", label: t("cron.jobs.all") },
        { value: "ok", label: t("cron.runs.runStatusOk") },
        { value: "error", label: t("cron.runs.runStatusError") },
        { value: "skipped", label: t("cron.runs.runStatusSkipped") },
        { value: "unknown", label: t("cron.runs.runStatusUnknown") },
      ]),
      choice("trigger", t("cron.jobs.condition"), [
        { value: "all", label: t("cron.jobs.all") },
        { value: "conditional", label: t("cron.jobs.conditional") },
        { value: "unconditional", label: t("cron.jobs.unconditional") },
      ]),
      choice("sort", t("cron.jobs.sort"), [
        { value: "name", label: t("cron.jobs.name") },
        { value: "nextRunAtMs", label: t("cron.jobs.nextRun") },
        { value: "updatedAtMs", label: t("cron.jobs.recentlyUpdated") },
      ]),
      choice("sortDir", t("cron.jobs.direction"), [
        { value: "asc", label: t("cron.jobs.ascending") },
        { value: "desc", label: t("cron.jobs.descending") },
      ]),
    ],
  });
}
