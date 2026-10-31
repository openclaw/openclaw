import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  onSettled,
  Reveal,
  Show,
} from "solid-js";
import type { CronJobsEnabledFilter, CronJob } from "../../api/types.ts";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { CronJobsPagination } from "../../components/cron-jobs-pagination.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon, sessionIcon } from "../../components/solid/icon.tsx";
import { SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { isCronJobActiveFailure, isCronJobRunning } from "../../lib/cron-status.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { CRON_SUGGESTIONS, suggestionFormPatch } from "./suggestions.ts";
import {
  AdminRequired,
  ErrorBanner,
  EnabledSwitch,
  JobMenu,
  NoticeBanner,
} from "./view-controls.tsx";
import {
  describeJobSchedule,
  describeJobNextRun,
  JobStateIndicator,
  TriggerIndicator,
  DisabledNote,
  LastRunCell,
} from "./view-job-status.tsx";
import { JobsFilterPopover } from "./view-jobs-filter.tsx";
import { RunsSection } from "./view-runs.tsx";
import type { CronJobActionProps, CronProps } from "./view-types.ts";
const ENABLED_TABS: Array<{
  value: CronJobsEnabledFilter;
  labelKey: string;
}> = [
  { value: "all", labelKey: "cron.tabs.all" },
  { value: "enabled", labelKey: "cron.tabs.active" },
  { value: "disabled", labelKey: "cron.tabs.paused" },
];
export function ListView(props: CronProps) {
  const scope = createMemo(() => props.reads?.scope() ?? true);
  // Retry readiness without recreating the table or erroring its row projection.
  const readJobs = () => {
    if (props.reads) {
      latest(props.reads.jobs);
    }
    return null;
  };
  const hasAdvancedJobsFilters = () =>
    props.jobsScheduleKindFilter !== "all" ||
    props.jobsLastStatusFilter !== "all" ||
    props.jobsTriggerFilter !== "all" ||
    props.jobsSortBy !== "nextRunAtMs" ||
    props.jobsSortDir !== "asc";
  const hasAnyJobsFilters = () =>
    hasAdvancedJobsFilters() ||
    props.jobsQuery.trim().length > 0 ||
    props.jobsEnabledFilter !== "all";
  const showStarterAutomations = () =>
    !props.loading &&
    props.hasLoaded &&
    !props.listError &&
    !props.error &&
    props.jobsTotal === 0 &&
    !hasAnyJobsFilters() &&
    props.canManage;
  return (
    <section class="cron-page" data-panel-mode="overview">
      <SettingsPage wide>
        <Errored
          fallback={(error, reset) => (
            <div class="cron-error-banner" role="alert">
              {String(error())}
              <button
                class="btn btn--sm"
                onClick={() => {
                  props.onRefresh();
                  reset();
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          )}
        >
          <Reveal order="natural">
            <div class="cron-overview-header">
              <AdminRequired {...props} />
              <Loading on={latest(scope)}>
                <SchedulerStatus {...props} />
              </Loading>
              <ErrorBanner error={props.listError} /> <ErrorBanner error={props.error} />
              <NoticeBanner notice={props.notice} />
              <Toolbar {...props} hasAdvancedJobsFilters={hasAdvancedJobsFilters()} />
            </div>
            <div
              id="cron-list-panel"
              class="cron-tab-panel"
              role="tabpanel"
              aria-labelledby={`cron-list-tab-${props.listTab === "activity" ? "activity" : props.jobsEnabledFilter}`}
            >
              {props.listTab === "activity" ? (
                <SettingsSection>
                  <div class="cron-activity">
                    <RunsSection {...props} />
                  </div>
                </SettingsSection>
              ) : (
                <>
                  <SettingsSection>
                    <Show when={latest(scope)} keyed>
                      {(_scope) => (
                        <Loading
                          fallback={
                            <JobsTableFrame canManage={props.canManage} busy>
                              <JobsLoading />
                            </JobsTableFrame>
                          }
                        >
                          {readJobs()}
                          <JobsTable {...props} hasAnyJobsFilters={hasAnyJobsFilters()} />
                        </Loading>
                      )}
                    </Show>
                  </SettingsSection>
                  {showStarterAutomations() ? <Suggestions {...props} /> : undefined}
                </>
              )}
            </div>
          </Reveal>
        </Errored>
      </SettingsPage>
    </section>
  );
}
function SchedulerStatus(props: CronProps) {
  const status = () => (props.reads ? props.reads.status() : props.status);
  return (
    <>
      {status() && !status()?.enabled ? (
        <div class="cron-error-banner" data-test-id="cron-scheduler-banner">
          <strong>{t("cron.list.schedulerOff")}</strong>
          {t("cron.runNotStarted.stopped")}
        </div>
      ) : undefined}
    </>
  );
}

function JobsLoading() {
  return (
    <div class="cron-empty-state" role="status" aria-live="polite" data-test-id="cron-jobs-loading">
      <div class="cron-empty-state__title">{t("cron.list.loading")}</div>
    </div>
  );
}

function ListTabs(props: CronProps) {
  return (
    <HubTabs<CronJobsEnabledFilter | "activity">
      {...{
        id: "cron-list",
        panelId: "cron-list-panel",
        class: "cron-tabs",
        active: props.listTab === "activity" ? "activity" : props.jobsEnabledFilter,
        tabs: [
          ...ENABLED_TABS.map((tab) => ({
            value: tab.value,
            label: t(tab.labelKey),
            testId: `cron-tab-${tab.value}`,
          })),
          {
            value: "activity",
            label: t("cron.list.activityTab"),
            testId: "cron-list-tab-activity",
          },
        ],
        ariaLabel: t("cron.list.viewLabel"),
        onSelect: (value) => {
          if (value === "activity") {
            props.onListTabChange("activity");
            return;
          }
          props.onListTabChange("tasks");
          if (value !== props.jobsEnabledFilter) {
            props.onJobsFiltersChange({ cronJobsEnabledFilter: value });
          }
        },
      }}
    />
  );
}
// Search owns the full first row; navigation and list actions share the row
// immediately above the table they affect.
function Toolbar(
  props: CronProps & {
    hasAdvancedJobsFilters: boolean;
  },
) {
  return (
    <div class="cron-toolbar">
      {props.listTab === "tasks" ? (
        <div class="cron-toolbar__filters">
          <div class="cron-search-box">
            <span class="cron-search-box__icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
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
          <button
            type="button"
            class={[
              "btn btn--sm btn--ghost cron-refresh",
              { "cron-refresh--loading": props.loading },
            ]}
            disabled={props.loading}
            title={props.loading ? t("cron.list.refreshing") : t("cron.list.refresh")}
            aria-label={t("cron.list.refresh")}
            onClick={() => props.onRefresh()}
          >
            <Icon name="refresh" />
          </button>
          {props.canManage ? (
            <button
              type="button"
              class="btn primary btn--sm cron-new-task"
              data-test-id="cron-new-task"
              onClick={() => props.onOpenCreate()}
            >
              <Icon name="plus" /> {t("cron.list.newTask")}
            </button>
          ) : undefined}
        </div>
      </div>
    </div>
  );
}
function JobsTable(
  props: CronProps & {
    hasAnyJobsFilters: boolean;
  },
) {
  // A snapshot revision is the successful-list fact. Until one exists, show
  // pending or failure, never completed-empty guidance.
  // Filter text and readiness updates must not rescan the retained inventory.
  const ownerJobs = createMemo(() => props.jobs);
  const readRows = createMemo(() => props.reads?.rows);
  const initialPending = () => props.loading && !props.hasLoaded;
  const tableBusy = () =>
    (props.reads ? isPending(props.reads.jobs) : props.loading) || props.jobsLoadingMore;
  const jobs = createMemo(() =>
    (readRows()?.() ?? ownerJobs()).toSorted(
      (left, right) => Number(isCronJobActiveFailure(right)) - Number(isCronJobActiveFailure(left)),
    ),
  );
  return (
    <JobsTableFrame canManage={props.canManage} busy={tableBusy()}>
      {jobs().length === 0 ? (
        initialPending() ? (
          <div
            class="cron-empty-state"
            role="status"
            aria-live="polite"
            data-test-id="cron-jobs-loading"
          >
            <div class="cron-empty-state__title">{t("cron.list.loading")}</div>
          </div>
        ) : props.hasLoaded ? (
          <div class="cron-empty-state">
            <div class="cron-empty-state__title">
              {props.hasAnyJobsFilters ? t("cron.list.noMatching") : t("cron.list.emptyTitle")}
            </div>
            {props.hasAnyJobsFilters ? undefined : (
              <div class="cron-empty-state__copy">{t("cron.list.emptyHint")}</div>
            )}
          </div>
        ) : undefined
      ) : (
        <JobRows {...props} rows={jobs()} />
      )}
      <CronJobsPagination
        jobsShown={props.jobs.length}
        jobsTotal={props.jobsTotal}
        hasMore={props.jobsHasMore}
        loading={props.loading}
        loadingMore={props.jobsLoadingMore}
        onLoadMore={props.onLoadMoreJobs}
      />
    </JobsTableFrame>
  );
}
// Keep the existing page scrollport and native row controls. Only geometry and
// materialized row lifetimes belong to the virtualizer; inventory stays with Cron.
function JobRows(props: CronProps & { rows: CronJob[] }) {
  let list: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  let synchronizeScrollOffset: (() => void) | undefined;
  let focusedId: string | undefined;
  let current: CronJob[] = [];
  const elements = new Set<HTMLDivElement>();
  const windowed = () => props.rows.length > 20;
  const canManage = createMemo(() => props.canManage);
  const busy = createMemo(() => props.busy);
  const connected = createMemo(() => props.connected);
  const getItemKey = createMemo(() => {
    const rows = props.rows;
    return (index: number) => rows[index]!.id;
  });
  const [window, setWindow] = createSignal<{ items: VirtualItem[]; height: number }>({
    items: [],
    height: 0,
  });
  const publish = () =>
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    estimateSize: () => 80,
    observeElementRect,
    observeElementOffset: (instance, notify) => {
      synchronizeScrollOffset = () =>
        notify(instance.scrollElement?.scrollTop ?? 0, instance.isScrolling);
      return observeElementOffset(instance, notify);
    },
    scrollToFn: elementScroll,
    overscan: 3,
    useAnimationFrameWithResizeObserver: true,
    onChange: publish,
  });
  const pinFocus = () => {
    const index = current.findIndex((job) => job.id === focusedId);
    // Entry from either end and native Tab across a window boundary need a real
    // destination. The focused row also retains an open top-layer action menu.
    const pinned = [0, current.length - 1, index - 1, index, index + 1].filter(
      (item) => item >= 0 && item < current.length,
    );
    virtualizer.setOptions({
      ...virtualizer.options,
      rangeExtractor: (range) =>
        [...new Set([...defaultRangeExtractor(range), ...pinned])].toSorted((a, b) => a - b),
    });
  };
  onSettled(() => {
    const { _didMount: mount } = virtualizer;
    return mount();
  });
  createLayoutMeasurement(
    () => ({ rows: props.rows, windowed: windowed(), getItemKey: getItemKey() }),
    (next) => {
      if (!next) {
        return;
      }
      const { rows } = next;
      scroller = list.closest<HTMLElement>(".content");
      current = rows;
      const margin = scroller
        ? list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
        : 0;
      virtualizer.setOptions({
        ...virtualizer.options,
        enabled: next.windowed && Boolean(scroller),
        count: rows.length,
        getItemKey: next.getItemKey,
        scrollMargin: margin,
      });
      pinFocus();
      const { _willUpdate: update } = virtualizer;
      update();
      for (const element of elements) {
        virtualizer.measureElement(element);
      }
      publish();
    },
    { targets: () => [list, ...(scroller ? [scroller] : [])], changeTiming: "sync", fonts: true },
  );
  createLayoutMeasurement(
    () => window().height,
    () => {
      // Retry a clamped scroll adjustment after Solid commits the measured height.
      const { _willUpdate: update } = virtualizer;
      update();
    },
    { targets: () => [list], changeTiming: "sync" },
  );
  const byId = createMemo(() => new Map(props.rows.map((job, index) => [job.id, { job, index }])));
  const geometry = createMemo(() => new Map(window().items.map((item) => [item.key, item])));
  const visible = createMemo(() => {
    if (!windowed()) {
      return props.rows;
    }
    if (!window().items.length) {
      return props.rows.slice(0, 12);
    }
    return window().items.flatMap((item) => byId().get(String(item.key))?.job ?? []);
  });
  function Row(row: { job: CronJob }) {
    let element: HTMLDivElement;
    const item = () => geometry().get(row.job.id);
    onSettled(() => {
      elements.add(element);
      virtualizer.measureElement(element);
      return () => {
        elements.delete(element);
        virtualizer.measureElement(null);
      };
    });
    return (
      <JobRow
        job={row.job}
        jobs={props.jobs}
        canManage={canManage()}
        busy={busy()}
        connected={connected()}
        toggleSavingJobId={props.toggleSavingJobId}
        onRun={(job, mode) => props.onRun(job, mode)}
        onToggle={(job, enabled) => props.onToggle(job, enabled)}
        onClone={(job) => props.onClone(job)}
        onRemove={(job) => props.onRemove(job)}
        onSelectJob={(job) => props.onSelectJob(job)}
        index={byId().get(row.job.id)!.index}
        count={props.rows.length}
        rowRef={(node) => (element = node)}
        onFocus={() => {
          if (focusedId === row.job.id) {
            return;
          }
          focusedId = row.job.id;
          if (windowed()) {
            // Native focus can scroll before the browser delivers its scroll event.
            synchronizeScrollOffset?.();
            pinFocus();
            publish();
            // Keep the native target visible as estimated mobile rows measure.
            virtualizer.scrollToIndex(byId().get(row.job.id)!.index);
          }
        }}
        style={
          windowed()
            ? {
                position: "absolute",
                width: "100%",
                top: `${(item()?.start ?? 0) - virtualizer.options.scrollMargin}px`,
              }
            : undefined
        }
      />
    );
  }
  return (
    <div
      ref={(node) => (list = node)}
      class="cron-table__rows"
      role="list"
      aria-label={t("cron.list.viewLabel")}
      style={
        windowed()
          ? { position: "relative", height: `${window().height || props.rows.length * 80}px` }
          : undefined
      }
    >
      <For each={visible()} keyed={(job) => job.id}>
        {(job) => <Row job={job()} />}
      </For>
    </div>
  );
}
function JobsTableFrame(props: { canManage: boolean; busy: boolean; children: JSX.Element }) {
  return (
    <div
      class={["cron-table", { "cron-table--read-only": !props.canManage }]}
      aria-busy={props.busy ? "true" : undefined}
    >
      <div class="cron-table__head">
        <span>{t("cron.jobs.name")}</span>
        <span>{t("cron.jobs.schedule")}</span>
        <span>{t("cron.jobs.nextRun")}</span>
        <span>{t("cron.jobs.lastRun")}</span>
        {props.canManage ? <span aria-hidden="true" /> : undefined}
      </div>
      {props.children}
    </div>
  );
}
function JobRow(
  props: CronJobActionProps &
    Pick<CronProps, "jobs" | "onSelectJob"> & {
      job: CronJob;
      index: number;
      count: number;
      rowRef: (node: HTMLDivElement) => void;
      onFocus: () => void;
      style?: JSX.CSSProperties;
    },
) {
  const displayName = () => props.job.displayName ?? props.job.name;
  const description = () => props.job.description?.trim();
  return (
    <div
      ref={props.rowRef}
      class={["cron-table__row", { "cron-table__row--paused": !props.job.enabled }]}
      role="listitem"
      aria-posinset={props.index + 1}
      aria-setsize={props.count}
      data-index={props.index}
      style={props.style}
      onFocusIn={() => props.onFocus()}
      data-test-id={`cron-row-${props.job.id}`}
      onClick={() => {
        const job = props.jobs.find((entry) => entry.id === props.job.id);
        if (job) {
          props.onSelectJob(job);
        }
      }}
    >
      <button type="button" class="cron-table__name">
        <JobStateIndicator job={props.job} />
        <span class="cron-table__name-copy">
          <span class="cron-table__name-line">
            <span class="cron-table__name-text">{displayName()}</span>
            {props.job.trigger ? <TriggerIndicator /> : undefined}
          </span>
          <AgentRowChip agentId={props.job.agentId} />
          {description() || !props.job.enabled ? (
            <span class="cron-table__name-meta">
              {description() ? (
                <span
                  class="cron-table__description"
                  data-test-id={`cron-row-description-${props.job.id}`}
                  title={`${t("cron.form.description")}: ${description()}`}
                >
                  {description()}
                </span>
              ) : undefined}
              {description() && !props.job.enabled ? (
                <span class="cron-table__meta-separator" aria-hidden="true">
                  ·
                </span>
              ) : undefined}
              {props.job.enabled ? undefined : <DisabledNote job={props.job} />}
            </span>
          ) : undefined}
        </span>
      </button>
      <JobCell
        class="cron-table__schedule"
        label={t("cron.jobs.schedule")}
        value={describeJobSchedule(props.job)}
      />
      <JobCell
        class="cron-table__next"
        label={t("cron.jobs.nextRun")}
        value={
          <span class={{ "cron-table__running": isCronJobRunning(props.job) }}>
            {describeJobNextRun(props.job)}
          </span>
        }
      />
      <JobCell
        class="cron-table__last"
        label={t("cron.jobs.lastRun")}
        value={<LastRunCell job={props.job} />}
      />
      {props.canManage ? (
        <span class="cron-table__actions" onClick={(e: Event) => e.stopPropagation()}>
          <button
            type="button"
            class="btn btn--sm btn--ghost cron-row-run"
            data-test-id={`cron-row-run-${props.job.id}`}
            title={t("cron.actions.runNowJob", { name: displayName() })}
            aria-label={t("cron.actions.runNowJob", { name: displayName() })}
            disabled={props.busy || !props.connected}
            onClick={() => props.onRun(props.job, "force")}
          >
            {sessionIcon("play", 12, 1.5)}
          </button>
          <EnabledSwitch {...props} job={props.job} compact />
          <JobMenu
            {...props}
            job={props.job}
            onClone={() => {
              const job = props.jobs.find((entry) => entry.id === props.job.id);
              if (job) {
                props.onClone(job);
              }
            }}
          />
        </span>
      ) : undefined}
    </div>
  );
}
function JobCell(props: { class: string; label: string; value: JSX.Element }) {
  return (
    <span class={["cron-table__cell", props.class]}>
      <span class="cron-table__cell-label">{props.label}</span>
      <span class="cron-table__cell-value">{props.value}</span>
    </span>
  );
}
function Suggestions(props: CronProps) {
  return (
    <SettingsSection title={t("cron.suggestions.title")}>
      <For each={CRON_SUGGESTIONS}>
        {(suggestion) => (
          <button
            type="button"
            class="settings-row settings-row--nav cron-suggestion"
            data-suggestion={suggestion.id}
            onClick={() => props.onOpenCreate(suggestionFormPatch(suggestion))}
          >
            <div class="settings-row__text">
              <span class="settings-row__title">
                <span aria-hidden="true">{suggestion.emoji}</span> {t(suggestion.nameKey)}
              </span>
              <span class="settings-row__desc">{t(suggestion.taglineKey)}</span>
            </div>
            <div class="settings-row__control">
              <span class="settings-row__value">{t(suggestion.scheduleKey)}</span>
              <span class="settings-row__chevron">
                <Icon name="chevronRight" />
              </span>
            </div>
          </button>
        )}
      </For>
    </SettingsSection>
  );
}
