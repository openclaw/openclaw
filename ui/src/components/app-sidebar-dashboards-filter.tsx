import { registerDashboardsEnglish } from "../i18n/locales/en-dashboards.ts";
import {
  dashboardAuthor,
  dashboardsFilter,
  DEFAULT_DASHBOARDS_FILTER,
  setDashboardsFilter,
} from "../lib/dashboards-filter.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { resolveSessionNavigationAgentId } from "../lib/sessions/route-navigation.ts";
import { renderSidebarSectionFilterMenu } from "./app-sidebar-section-filter.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";

registerEnglishCatalog(registerDashboardsEnglish);

/** Whether the Dashboards sidebar filter differs from its defaults. */
export function dashboardsFiltered(): boolean {
  return (
    dashboardsFilter().authorId !== DEFAULT_DASHBOARDS_FILTER.authorId ||
    dashboardsFilter().sort !== DEFAULT_DASHBOARDS_FILTER.sort
  );
}

/** The Dashboards sidebar filter: one author or all of them, and the order. */
export function renderSidebarDashboardsFilterMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
) {
  const authors = () => {
    const context = host.sessionDataContext;
    const fallbackAgentId = context ? resolveSessionNavigationAgentId(context) : "main";
    const labels = new Map<string, string>();
    for (const row of host.navigationCatalog.dashboards?.result?.sessions ?? []) {
      const author = dashboardAuthor(row, fallbackAgentId);
      labels.set(author.id, author.label);
    }
    return [...labels]
      .map(([value, label]) => ({ value, label }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  };
  return renderSidebarSectionFilterMenu(menus, "dashboardsFilter", {
    label: t("chat.sidebar.menuFilters"),
    resetLabel: t("common.reset"),
    filtered: dashboardsFiltered,
    onReset: () => setDashboardsFilter(DEFAULT_DASHBOARDS_FILTER),
    pickers: () => [
      {
        id: "sidebar-dashboards-author",
        label: t("dashboardsPage.groupAuthor"),
        value: dashboardsFilter().authorId ?? "",
        options: [{ value: "", label: t("sessionsView.all") }, ...authors()],
        onChange: (value) =>
          setDashboardsFilter({ ...dashboardsFilter(), authorId: value || null }),
      },
      {
        id: "sidebar-dashboards-sort",
        label: t("dashboardsPage.ordering"),
        value: dashboardsFilter().sort,
        options: [
          { value: "updated", label: t("dashboardsPage.sortUpdated") },
          { value: "title", label: t("dashboardsPage.sortTitle") },
        ],
        onChange: (value) =>
          setDashboardsFilter({
            ...dashboardsFilter(),
            sort: value === "title" ? "title" : "updated",
          }),
      },
    ],
  });
}
