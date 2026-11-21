import { For } from "solid-js";
import { iconButtonClass } from "../../components/solid/icon-button.tsx";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { DashboardGalleryFilters, DashboardGalleryHandlers } from "./gallery-filters.ts";

/** Grid or list, ordering and grouping; the card always shows preview, author and time. */
export function DashboardDisplayMenu(props: {
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
}) {
  const views = (): [DashboardGalleryFilters["view"], IconName, string][] => [
    ["grid", "layoutGrid", t("dashboardsPage.viewGrid")],
    ["list", "list", t("dashboardsPage.viewList")],
  ];
  return (
    <Popover
      id="dashboards-display"
      class="dashboards-display"
      label={t("dashboardsPage.display")}
      lazy="while-open"
      placement="bottom-end"
      triggerClass={[iconButtonClass(), "dashboards-display__trigger"]}
      triggerTitle={t("dashboardsPage.display")}
      triggerAriaLabel={t("dashboardsPage.display")}
      trigger={<Icon name="slidersHorizontal" />}
    >
      <div class="dashboards-display__views" role="group" aria-label={t("dashboardsPage.display")}>
        <For each={views()} keyed={([view]) => view}>
          {(entry) => (
            <button
              type="button"
              class="dashboards-display__view"
              aria-pressed={props.filters.view === entry()[0] ? "true" : "false"}
              onClick={() => props.handlers.onFilterChange({ view: entry()[0] })}
            >
              <Icon name={entry()[1]} />
              {entry()[2]}
            </button>
          )}
        </For>
      </div>
      <label class="dashboards-display__row">
        <span>{t("dashboardsPage.ordering")}</span>
        <select
          class="settings-select"
          value={props.filters.sort}
          onChange={(event) => {
            const sort = event.currentTarget.value;
            if (sort === "updated" || sort === "title") {
              props.handlers.onFilterChange({ sort });
            }
          }}
        >
          <option value="updated">{t("dashboardsPage.sortUpdated")}</option>
          <option value="title">{t("dashboardsPage.sortTitle")}</option>
        </select>
      </label>
      <label class="dashboards-display__row">
        <span>{t("dashboardsPage.grouping")}</span>
        <select
          class="settings-select"
          value={props.filters.group}
          onChange={(event) => {
            const group = event.currentTarget.value;
            if (group === "none" || group === "updated" || group === "author") {
              props.handlers.onFilterChange({ group });
            }
          }}
        >
          <option value="none">{t("dashboardsPage.groupNone")}</option>
          <option value="updated">{t("dashboardsPage.groupUpdated")}</option>
          <option value="author">{t("dashboardsPage.groupAuthor")}</option>
        </select>
      </label>
    </Popover>
  );
}
