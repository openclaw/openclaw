import { createMemo, createSignal, action, createOptimistic } from "solid-js";
import type { CronJobsEnabledFilter } from "../../api/types.ts";
import { HeaderSearchField } from "../../components/solid/header-search.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { iconButtonClass } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { JobsFilterPopover } from "./view-jobs-filter.tsx";
import { RunToolbar } from "./view-run-filters.tsx";
import type { CronProps } from "./view-types.ts";
const ENABLED_TABS: Array<{
  value: CronJobsEnabledFilter;
  labelKey: string;
}> = [
  { value: "all", labelKey: "cron.tabs.all" },
  { value: "enabled", labelKey: "cron.tabs.active" },
  { value: "disabled", labelKey: "cron.tabs.paused" },
];
function ListTabs(props: CronProps) {
  const active = createMemo(() =>
    props.listTab === "activity"
      ? props.phoneLayout
        ? "activity"
        : null
      : props.jobsEnabledFilter,
  );
  return (
    <HubTabs<CronJobsEnabledFilter | "activity">
      id="cron-list"
      panelId="cron-list-panel"
      class="cron-tabs"
      active={active()}
      tabs={[
        ...ENABLED_TABS.map((tab) => ({
          value: tab.value,
          label: t(tab.labelKey),
          testId: `cron-tab-${tab.value}`,
        })),
        ...(props.phoneLayout
          ? [
              {
                value: "activity" as const,
                label: t("cron.list.activityTab"),
                testId: "cron-list-tab-activity",
              },
            ]
          : []),
      ]}
      ariaLabel={t("cron.list.viewLabel")}
      onSelect={(value) => {
        if (value === "activity") {
          props.onListTabChange("activity");
          return;
        }
        props.onListTabChange("tasks");
        if (value !== props.jobsEnabledFilter) {
          props.onJobsFiltersChange({ cronJobsEnabledFilter: value });
        }
      }}
    />
  );
}
export function ListToolbar(
  props: CronProps & {
    hasAdvancedJobsFilters: boolean;
  },
) {
  // The jobs read holds its results in a transition; only an optimistic value shows during it.
  const [manualRefresh, setManualRefresh] = createOptimistic(false);
  const refreshing = () => manualRefresh() || props.loading;
  const refresh = action(function* () {
    const retired = props.getActionRetired();
    setManualRefresh(true);
    yield Promise.race([props.onRefresh(), retired]);
  });
  const newTask = () =>
    (props.canCreate ?? props.canManage) ? (
      <button
        ref={props.focus?.ref("create")}
        type="button"
        class="btn primary btn--sm cron-new-task"
        data-test-id="cron-new-task"
        onClick={() => props.onOpenCreate()}
      >
        <Icon name="plus" /> {t("cron.list.newTask")}
      </button>
    ) : undefined;

  const [searchExpanded, setSearchExpanded] = createSignal(false);
  const searchOpen = () => searchExpanded() || props.jobsQuery.length > 0;
  let searchToggle!: HTMLButtonElement;
  const closeSearch = () => {
    props.onJobsFiltersChange({ cronJobsQuery: "" });
    setSearchExpanded(false);
    searchToggle.focus();
  };
  const phoneToolbar = () => (
    <div class="cron-toolbar">
      {props.phoneLayout ? (
        <div class="cron-toolbar__scope">
          {props.toolbarScope}
          {newTask()}
        </div>
      ) : undefined}
      {props.listTab === "tasks" ? (
        <div class="cron-toolbar__filters">
          <div class="cron-search-box">
            <span class="cron-search-box__icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              ref={props.focus?.ref("search")}
              type="search"
              class="settings-input"
              value={props.jobsQuery}
              aria-label={t("cron.list.searchPlaceholder")}
              placeholder={t("cron.list.searchPlaceholder")}
              onInput={(e) =>
                props.onJobsFiltersChange({
                  cronJobsQuery: e.currentTarget.value,
                })
              }
            />
          </div>
          <JobsFilterPopover {...props} active={props.hasAdvancedJobsFilters} />
        </div>
      ) : undefined}
      <div class="cron-toolbar__primary">
        <ListTabs {...props} />
        <div class="cron-toolbar__actions">
          <RefreshButton
            class="cron-refresh"
            label={t("cron.list.refresh")}
            tooltip={refreshing() ? t("cron.list.refreshing") : t("cron.list.refresh")}
            busy={refreshing()}
            onClick={() => void refresh()}
          />
          {props.phoneLayout ? undefined : newTask()}
        </div>
      </div>
    </div>
  );
  return (
    <>
      {props.phoneLayout ? (
        phoneToolbar()
      ) : props.listTab === "activity" ? (
        <RunToolbar {...props} />
      ) : (
        <div class="cron-toolbar">
          <div class="cron-toolbar__primary">
            <div class="cron-toolbar__navigation">
              <ListTabs {...props} />
            </div>
            <div class="cron-toolbar__actions">
              {props.listTab === "tasks" ? (
                <div class="cron-toolbar__filters">
                  {searchOpen() ? (
                    <HeaderSearchField
                      class="settings-input cron-search-field"
                      label={t("cron.list.searchPlaceholder")}
                      query={props.jobsQuery}
                      focus={searchExpanded()}
                      controlRef={() => props.focus?.ref("search")}
                      onQueryChange={(query) => {
                        setSearchExpanded(true);
                        props.onJobsFiltersChange({ cronJobsQuery: query });
                      }}
                      onClose={closeSearch}
                    />
                  ) : undefined}
                  <button
                    ref={[
                      props.focus?.ref("search", () => !searchOpen()),
                      (element: HTMLButtonElement) => (searchToggle = element),
                    ]}
                    type="button"
                    class={[iconButtonClass(), "cron-search-toggle"]}
                    aria-label={searchOpen() ? t("common.close") : t("cron.list.searchPlaceholder")}
                    title={searchOpen() ? t("common.close") : t("cron.list.searchPlaceholder")}
                    onClick={() => (searchOpen() ? closeSearch() : setSearchExpanded(true))}
                  >
                    <Icon name={searchOpen() ? "x" : "search"} />
                  </button>
                  <JobsFilterPopover {...props} active={props.hasAdvancedJobsFilters} />
                </div>
              ) : undefined}
              <RefreshButton
                class="cron-refresh"
                label={t("cron.list.refresh")}
                tooltip={refreshing() ? t("cron.list.refreshing") : t("cron.list.refresh")}
                busy={refreshing()}
                onClick={() => void refresh()}
              />
              {newTask()}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
