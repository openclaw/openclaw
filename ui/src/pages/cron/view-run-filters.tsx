import { createMemo, createSignal } from "solid-js";
import { HeaderSearchField } from "../../components/solid/header-search.tsx";
import { IconButton, iconButtonClass } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import { i18n } from "../../i18n/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { RUN_STATUS_LABELS, RUN_DELIVERY_LABELS } from "./view-run-status.ts";
import type { CronRunsSectionProps } from "./view-runs.tsx";

function toggleSelection<T extends string>(selected: T[], value: T, checked: boolean): T[] {
  const set = new Set(selected);
  if (checked) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return Array.from(set);
}
const FILTER_OPTION_PREFIX = "option:";
const FILTER_COMMAND_PREFIX = "command:";
function FilterDropdown<T extends string>(props: {
  id: string;
  title: string;
  allLabel: string;
  options: Array<{
    value: T;
    label: string;
  }>;
  selected: T[];
  onToggle: (value: T, checked: boolean) => void;
  onClear: () => void;
}) {
  const selectedLabels = () =>
    props.options
      .filter((option) => props.selected.includes(option.value))
      .map((option) => option.label);
  const summary = () =>
    selectedLabels().length === 0
      ? props.allLabel
      : selectedLabels().length <= 2
        ? selectedLabels().join(", ")
        : `${selectedLabels()[0]} +${selectedLabels().length - 1}`;
  const accessibleSummary = createMemo(() =>
    selectedLabels().length > 2
      ? `${summary()} (${new Intl.ListFormat(i18n.getLocale(), {
          style: "long",
          type: "conjunction",
        }).format(selectedLabels())})`
      : summary(),
  );
  return (
    <div class="cron-filter-dropdown" data-filter={props.id}>
      <Menu
        id={`cron-runs-filter-${props.id}`}
        label={`${props.title} ${accessibleSummary()}`}
        class="cron-filter-dropdown__details"
        triggerClass={[
          "btn btn--sm cron-filter-dropdown__trigger",
          { active: props.selected.length > 0 },
        ]}
        triggerAttributes={{ title: props.title }}
        trigger={
          <>
            <span>{summary()}</span>
            <Icon name="chevronDown" />
          </>
        }
        placement="bottom-start"
        items={[
          ...props.options.map((option) => ({
            id: `${FILTER_OPTION_PREFIX}${option.value}`,
            label: option.label,
            class: "cron-filter-dropdown__option",
            type: "checkbox" as const,
            checked: props.selected.includes(option.value),
            closeOnSelect: false,
          })),
          {
            kind: "content",
            id: "separator",
            content: <div class="session-menu__separator" role="separator" />,
          },
          {
            id: `${FILTER_COMMAND_PREFIX}clear`,
            label: t("cron.runs.clear"),
            class: "cron-filter-dropdown__clear",
          },
        ]}
        onSelect={(item) => {
          if (item.id === `${FILTER_COMMAND_PREFIX}clear`) {
            props.onClear();
          } else if (item.id.startsWith(FILTER_OPTION_PREFIX)) {
            const option = props.options.find(
              (candidate) => candidate.value === item.id.slice(FILTER_OPTION_PREFIX.length),
            );
            if (option) {
              props.onToggle(option.value, !props.selected.includes(option.value));
            }
          }
        }}
      />
    </div>
  );
}
function RunFilterMenus(props: CronRunsSectionProps) {
  const sortLabel = () =>
    props.runsSortDir === "asc" ? t("cron.runs.oldestFirst") : t("cron.runs.newestFirst");
  return (
    <>
      <FilterDropdown
        id="status"
        title={t("cron.runs.status")}
        allLabel={t("cron.runs.allStatuses")}
        options={Array.from(RUN_STATUS_LABELS, ([value, key]) => ({
          value,
          label: t(key),
        }))}
        selected={props.runsStatuses}
        onToggle={(value, checked) => {
          const next = toggleSelection(props.runsStatuses, value, checked);
          props.onRunsFiltersChange({ cronRunsStatuses: next });
        }}
        onClear={() => {
          props.onRunsFiltersChange({ cronRunsStatuses: [] });
        }}
      />
      <FilterDropdown
        id="delivery"
        title={t("cron.runs.delivery")}
        allLabel={t("cron.runs.allDelivery")}
        options={Array.from(RUN_DELIVERY_LABELS, ([value, key]) => ({
          value,
          label: t(key),
        }))}
        selected={props.runsDeliveryStatuses}
        onToggle={(value, checked) => {
          const next = toggleSelection(props.runsDeliveryStatuses, value, checked);
          props.onRunsFiltersChange({ cronRunsDeliveryStatuses: next });
        }}
        onClear={() => {
          props.onRunsFiltersChange({ cronRunsDeliveryStatuses: [] });
        }}
      />
      <div class="cron-filter-dropdown">
        <Menu
          id="cron-runs-sort"
          label={`${t("cron.jobs.sort")} ${sortLabel()}`}
          class="cron-filter-dropdown__details"
          triggerClass="btn btn--sm cron-filter-dropdown__trigger cron-run-sort"
          trigger={
            <>
              <span>{sortLabel()}</span>
              <Icon name="chevronDown" />
            </>
          }
          placement="bottom-start"
          items={[
            {
              id: "desc",
              label: t("cron.runs.newestFirst"),
              attributes: { "aria-current": props.runsSortDir === "desc" ? "true" : "false" },
              details: (
                <span aria-hidden="true">
                  {props.runsSortDir === "desc" ? <Icon name="check" /> : undefined}
                </span>
              ),
            },
            {
              id: "asc",
              label: t("cron.runs.oldestFirst"),
              attributes: { "aria-current": props.runsSortDir === "asc" ? "true" : "false" },
              details: (
                <span aria-hidden="true">
                  {props.runsSortDir === "asc" ? <Icon name="check" /> : undefined}
                </span>
              ),
            },
          ]}
          onSelect={(item) => {
            if (item.id === "asc" || item.id === "desc") {
              props.onRunsFiltersChange({ cronRunsSortDir: item.id });
            }
          }}
        />
      </div>
    </>
  );
}

export function RunFilters(props: CronRunsSectionProps) {
  return (
    <div class="cron-run-filters">
      <div class="cron-search-box cron-run-filter-search">
        <span class="cron-search-box__icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          type="search"
          class="settings-input"
          value={props.runsQuery}
          aria-label={t("cron.runs.searchRuns")}
          placeholder={t("cron.runs.searchPlaceholder")}
          onInput={(e) =>
            props.onRunsFiltersChange({
              cronRunsQuery: e.currentTarget.value,
            })
          }
        />
      </div>
      <RunFilterMenus {...props} />
    </div>
  );
}

export function RunToolbar(props: CronRunsSectionProps) {
  const [searchExpanded, setSearchExpanded] = createSignal(false);
  const searchOpen = () => searchExpanded() || props.runsQuery.length > 0;
  const active = () =>
    props.runsStatuses.length > 0 ||
    props.runsDeliveryStatuses.length > 0 ||
    props.runsSortDir !== "desc";
  let toggle!: HTMLButtonElement;
  const closeSearch = () => {
    props.onRunsFiltersChange({ cronRunsQuery: "" });
    setSearchExpanded(false);
    toggle.focus({ preventScroll: true });
  };
  return (
    <div class="cron-toolbar cron-run-toolbar">
      <div class="cron-toolbar__primary">
        <div class="cron-toolbar__actions">
          <div class="cron-toolbar__filters">
            {searchOpen() ? (
              <HeaderSearchField
                class="settings-input cron-search-field"
                label={t("cron.runs.searchRuns")}
                placeholder={t("cron.runs.searchPlaceholder")}
                query={props.runsQuery}
                focus={searchExpanded()}
                onQueryChange={(query) => {
                  setSearchExpanded(true);
                  props.onRunsFiltersChange({ cronRunsQuery: query });
                }}
                onClose={closeSearch}
              />
            ) : undefined}
            <IconButton
              ref={(element) => (toggle = element)}
              class="cron-search-toggle"
              icon={searchOpen() ? "x" : "search"}
              label={searchOpen() ? t("common.close") : t("cron.runs.searchRuns")}
              onClick={() => (searchOpen() ? closeSearch() : setSearchExpanded(true))}
            />
            <Popover
              id="cron-runs-filters"
              label={t("cron.list.filters")}
              class="cron-filter-popover"
              triggerClass={[iconButtonClass(), { active: active() }]}
              trigger={<Icon name="listFilter" />}
              placement="bottom-end"
            >
              <div class="cron-filter-popover__panel">
                <RunFilterMenus {...props} />
              </div>
            </Popover>
          </div>
          {(props.canCreate ?? props.canManage) ? (
            <button
              ref={props.focus?.ref("create")}
              type="button"
              class="btn primary btn--sm cron-new-task"
              data-test-id="cron-new-task"
              onClick={() => props.onOpenCreate?.()}
            >
              <Icon name="plus" /> {t("cron.list.newTask")}
            </button>
          ) : undefined}
        </div>
      </div>
    </div>
  );
}
