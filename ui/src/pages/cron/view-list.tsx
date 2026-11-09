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
import type { CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsSection, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { isCronJobActiveFailure } from "../../lib/cron-status.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { CRON_SUGGESTIONS, suggestionFormPatch } from "./suggestions.ts";
import { AdminRequired, ErrorBanner, NoticeBanner } from "./view-controls.tsx";
import { JobRow } from "./view-job-row.tsx";
import { ListToolbar } from "./view-list-toolbar.tsx";
import { RunsSection } from "./view-runs.tsx";
import type { CronProps } from "./view-types.ts";
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
    <section
      class={["cron-page", { "cron-page--desktop": !props.phoneLayout }]}
      data-panel-mode="overview"
    >
      <SettingsPage wide>
        <Errored
          fallback={(error, reset) => (
            <InlineAlert
              tone="danger"
              action={
                <button
                  class="btn btn--sm"
                  onClick={() => {
                    void props.onRefresh();
                    reset();
                  }}
                >
                  {t("common.retry")}
                </button>
              }
            >
              {formatUiError(error())}
            </InlineAlert>
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
              <ListToolbar {...props} hasAdvancedJobsFilters={hasAdvancedJobsFilters()} />
            </div>
            <div
              id="cron-list-panel"
              class="cron-tab-panel"
              role={!props.phoneLayout && props.listTab === "activity" ? "region" : "tabpanel"}
              aria-label={
                !props.phoneLayout && props.listTab === "activity"
                  ? t("cron.list.runHistory")
                  : undefined
              }
              aria-labelledby={
                !props.phoneLayout && props.listTab === "activity"
                  ? undefined
                  : `cron-list-tab-${props.listTab === "activity" ? "activity" : props.jobsEnabledFilter}`
              }
            >
              {props.listTab === "activity" ? (
                <ListSection phoneLayout={props.phoneLayout}>
                  <div class="cron-activity">
                    <RunsSection {...props} overview />
                  </div>
                </ListSection>
              ) : (
                <>
                  <ListSection phoneLayout={props.phoneLayout}>
                    <Show when={latest(scope)} keyed>
                      {(_scope) => (
                        <Loading
                          fallback={
                            <JobsTableFrame
                              phoneLayout={props.phoneLayout}
                              canManage={props.canManage}
                              busy
                            >
                              <JobsLoading />
                            </JobsTableFrame>
                          }
                        >
                          {readJobs()}
                          <JobsTable {...props} hasAnyJobsFilters={hasAnyJobsFilters()} />
                        </Loading>
                      )}
                    </Show>
                  </ListSection>
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
function ListSection(props: { phoneLayout?: boolean; children: JSX.Element }) {
  return (
    <>{props.phoneLayout ? <SettingsSection>{props.children}</SettingsSection> : props.children}</>
  );
}
function SchedulerStatus(props: CronProps) {
  const status = () => (props.reads ? props.reads.status() : props.status);
  return (
    <>
      {status() && !status()?.enabled ? (
        <InlineAlert
          tone="warning"
          data-test-id="cron-scheduler-banner"
          title={t("cron.list.schedulerOff")}
        >
          {t("cron.runNotStarted.stopped")}
        </InlineAlert>
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
    <JobsTableFrame phoneLayout={props.phoneLayout} canManage={props.canManage} busy={tableBusy()}>
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
      {props.jobsLoadingMore ? (
        <div
          class="cron-jobs-loading-more"
          role="status"
          aria-label={t("cron.list.loading")}
          data-test-id="cron-jobs-loading-more"
        >
          <span class="btn__spinner" aria-hidden="true" />
        </div>
      ) : undefined}
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
  const canCreate = createMemo(() => props.canCreate);
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
  let committedWindow: ReturnType<typeof window> | undefined;
  let requestingMore = false;
  const loadNearEnd = () => {
    // Focus navigation also pins the final row; only the actual viewport range
    // can request another page. The Cron owner still admits and validates it.
    const end = virtualizer.range?.endIndex;
    if (
      requestingMore ||
      !props.connected ||
      props.loading ||
      props.jobsLoadingMore ||
      props.listError ||
      !props.jobsHasMore ||
      end === undefined ||
      end < props.rows.length - 6
    ) {
      return;
    }
    requestingMore = true;
    void Promise.resolve(props.onLoadMoreJobs()).finally(() => {
      requestingMore = false;
    });
  };
  const publish = () => {
    setWindow({ items: virtualizer.getVirtualItems(), height: virtualizer.getTotalSize() });
    loadNearEnd();
  };
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
    // An appended page can introduce failures before the visible healthy rows.
    // Keep their keys and viewport position without following the new tail.
    anchorTo: "end",
    followOnAppend: false,
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
      focusedId ??= props.focus?.target;
      scroller = list.closest<HTMLElement>(".content");
      // Native scrolling can precede its scroll event. Capture that offset
      // against the old keys before the virtualizer anchors an appended page.
      if (rows !== current) {
        synchronizeScrollOffset?.();
      }
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
      // Attach observers now; append anchoring waits for the new list height.
      if (virtualizer.scrollElement !== scroller) {
        const { _willUpdate: update } = virtualizer;
        update();
      }
      for (const element of elements) {
        virtualizer.measureElement(element);
      }
      publish();
    },
    { targets: () => [list, ...(scroller ? [scroller] : [])], changeTiming: "sync", fonts: true },
  );
  createLayoutMeasurement(
    () => ({
      window: window(),
      loading: props.loading,
      loadingMore: props.jobsLoadingMore,
      hasMore: props.jobsHasMore,
      error: props.listError,
    }),
    (next) => {
      // Only committed geometry can consume the pending anchor. A loading-flag
      // update can precede that commit and clamp the scroll to the old height.
      if (next && next.window !== committedWindow) {
        committedWindow = next.window;
        const { _willUpdate: update } = virtualizer;
        update();
      }
      loadNearEnd();
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
    // Equal permission results must not wake the retained row controls.
    const canManageJob = createMemo(() => props.canManageJob?.(row.job) ?? canManage());
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
        phoneLayout={props.phoneLayout}
        jobs={props.jobs}
        canManage={canManageJob()}
        canCreate={canCreate()}
        busy={busy()}
        connected={connected()}
        toggleSavingJobId={props.toggleSavingJobId}
        onRun={(job, mode) => props.onRun(job, mode)}
        onToggle={(job, enabled) => props.onToggle(job, enabled)}
        onClone={(job) => props.onClone(job)}
        onRemove={(job) => props.onRemove(job)}
        onSelectJob={(job) => {
          props.focus?.remember(
            job.id,
            props.rows.map((entry) => entry.id),
          );
          props.onSelectJob(job);
        }}
        index={byId().get(row.job.id)!.index}
        count={props.rows.length}
        focus={props.focus}
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
function JobsTableFrame(props: {
  phoneLayout?: boolean;
  canManage: boolean;
  busy: boolean;
  children: JSX.Element;
}) {
  return (
    <div
      class={["cron-table", { "cron-table--read-only": props.phoneLayout && !props.canManage }]}
      aria-busy={props.busy ? "true" : undefined}
    >
      {props.phoneLayout ? (
        <div class="cron-table__head">
          <span>{t("cron.jobs.name")}</span>
          <span>{t("cron.jobs.schedule")}</span>
          <span>{t("cron.jobs.nextRun")}</span>
          <span>{t("cron.jobs.lastRun")}</span>
          {props.canManage ? <span aria-hidden="true" /> : undefined}
        </div>
      ) : undefined}
      {props.children}
    </div>
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
