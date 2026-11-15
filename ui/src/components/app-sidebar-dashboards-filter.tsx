import { registerDashboardsEnglish } from "../i18n/locales/en-dashboards.ts";
import {
  dashboardAuthor,
  dashboardsFilter,
  DEFAULT_DASHBOARDS_FILTER,
  setDashboardsFilter,
} from "../lib/dashboards-filter.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { resolveSessionNavigationAgentId } from "../lib/sessions/route-navigation.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { SidebarSectionFilter } from "./app-sidebar-section-filter.tsx";

registerEnglishCatalog(registerDashboardsEnglish);

/** The Dashboards sidebar filter: one author or all of them, and the order. */
export function SidebarDashboardsFilter(props: { host: AppSidebarRenderHost }) {
  const app = useApplication();
  const authors = () => {
    const fallbackAgentId = resolveSessionNavigationAgentId(app);
    const labels = new Map<string, string>();
    for (const row of props.host.navigationCatalog.dashboards?.result?.sessions ?? []) {
      const author = dashboardAuthor(row, fallbackAgentId);
      labels.set(author.id, author.label);
    }
    return [...labels]
      .map(([value, label]) => ({ value, label }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  };
  const filtered = () =>
    dashboardsFilter().authorId !== DEFAULT_DASHBOARDS_FILTER.authorId ||
    dashboardsFilter().sort !== DEFAULT_DASHBOARDS_FILTER.sort;
  return (
    <SidebarSectionFilter
      label={t("chat.sidebar.menuFilters")}
      filtered={filtered()}
      resetLabel={t("common.reset")}
      onReset={() => setDashboardsFilter(DEFAULT_DASHBOARDS_FILTER)}
      pickers={[
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
      ]}
    />
  );
}
