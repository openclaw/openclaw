// Preserve stylesheet evaluation order across the folded view imports.
import "../../styles/tabs.css";
import "../../styles/hub-tabs.css";
import "../../styles/settings.css";
import "./run-inspector.css";
import "../../components/theme-brand-icon.css";
import "../../styles/identity-avatar.css";
import "../../styles/agent-row-chip.css";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { JSX } from "@solidjs/web";
import {
  createDeferred,
  createMemo,
  createSignal,
  createStore,
  Match,
  onSettled,
  Show,
  Switch,
  For,
} from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { HeaderSearch } from "../../components/solid/header-search.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsStatus, SettingsToggle } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import { projectPresencePayload } from "../../lib/presence-users.ts";
import { t, getLocale, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { useStreamAutoFollow } from "../../lib/reactive/stream-auto-follow.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ActivityPageState } from "./activity-page-state.ts";
import { renderCurrentWork as CurrentWork } from "./current-work-view.tsx";
import { activityRunInspectorHref } from "./run-inspector-model.ts";
import { renderRunInspector as RunInspector } from "./run-inspector-view.tsx";
import { ACTIVITY_SUMMARY_ENSURE_METHOD } from "./session-activity-owner.ts";
import { renderSessionActivityView as SessionActivityView } from "./session-activity-view.tsx";
import "../../styles/activity.css";
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";

registerEnglishCatalog(registerActivityEnglish);

const STATUS_ORDER: ActivityStatus[] = ["running", "done", "error"];

function yieldActivityRender(): Promise<void> {
  // SAFETY: scheduler.yield is an optional browser API; timers cover WebKit.
  const browser = globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  };
  return (
    browser.scheduler?.yield?.() ??
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    })
  );
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return t("common.na");
  }
  return formatDurationCompact(value) ?? "0ms";
}

function hiddenArgumentsLabel(count: number): string {
  if (count === 1) {
    return t("activity.argumentHiddenOne");
  }
  return t("activity.argumentsHidden", { count: String(count) });
}

function buildEntrySummary(entry: ActivityEntry): string {
  if (entry.entryKind === "answer_candidate") {
    return t(`activity.answerCandidate.${entry.candidateStatus ?? "candidate"}`);
  }
  return hiddenArgumentsLabel(entry.hiddenArgumentCount);
}

function entryLabel(entry: ActivityEntry): string {
  return entry.entryKind === "answer_candidate"
    ? t("activity.answerCandidate.title")
    : entry.toolName;
}

function matchesEntry(entry: ActivityEntry, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      entry.toolName,
      entryLabel(entry),
      entry.candidateStatus,
      entry.status,
      entry.summary,
      buildEntrySummary(entry),
      entry.outputPreview,
      entry.runId,
      entry.toolCallId,
      entry.sessionKey,
    ]
      .filter(Boolean)
      .join(" "),
  ).normalize("NFC");
  return haystack.includes(needle);
}

const STATUS_KINDS = { running: "running", done: "ok", error: "danger" } as const satisfies Record<
  ActivityStatus,
  "running" | "ok" | "danger"
>;

function toggle(ids: ReadonlySet<string>, id: string, open = !ids.has(id)) {
  const next = new Set(ids);
  if (open) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

export function ActivityPageView(pageProps: { page: ActivityPageState }) {
  const state = () => pageProps.page.read();
  const liveSnapshot = () => pageProps.page.liveActivity.read();
  const pageRevision = () =>
    pageProps.page.revision() +
    pageProps.page.liveActivity.revision() +
    pageProps.page.agents.revision();
  const [filters, setFilters] = createStore({
    filterText: "",
    toolFilter: "",
    autoFollow: true,
    statusFilters: { running: true, done: true, error: true },
  });
  const update = (patch: Partial<typeof filters>) =>
    setFilters((draft) => Object.assign(draft, patch));
  const [liveSearchOpen, setLiveSearchOpen] = createSignal(false);
  const liveRevision = createMemo(() => liveSnapshot().revision);
  const [expandedIds, setExpandedIds] = createSignal(() => {
    liveRevision();
    return new Set<string>();
  });
  const [expandedAutomationDays, setExpandedAutomationDays] = createSignal(new Set<string>());
  const route = createMemo(() => state().routeData ?? state().presentedRoute?.data);
  const location = createMemo(() => state().routeLocation ?? state().presentedRoute?.location);
  const sessionRoute = createMemo(() => {
    const current = route();
    return current?.mode === "sessions" ? current : undefined;
  });
  const runRoute = createMemo(() => {
    const current = route();
    return current?.mode === "run" ? current : undefined;
  });
  const pending = () => !state().routeData || !state().routeLocation;
  const presence = () => projectPresencePayload(state().presencePayload).users;
  const sessionHost = () => ({
    agentsList: pageProps.page.agents.read().agentsList,
    hello: state().context.gateway.snapshot.hello,
  });
  // Match the page-scrolling layout in activity.css, including short landscape phones.
  const pageScrolls = createMediaQuery(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  );
  let stream: HTMLDivElement | undefined;
  // Resolve ancestry after insertion; the stream ref is assigned before it joins main.
  const scrollContainer = () =>
    pageScrolls() ? (stream?.closest<HTMLElement>("main.content") ?? stream) : stream;
  const follow = useStreamAutoFollow({
    container: scrollContainer,
    enabled: () => filters.autoFollow,
    identity: liveRevision,
    content: () => liveSnapshot().entries,
  });
  const [presentationTime, setPresentationTime] = createSignal(Date.now());
  const activityExpiry = createPresenceActivityLifecycle(presence, () =>
    setPresentationTime(Date.now()),
  );
  onSettled(() => {
    const stop = pageProps.page.subscribe(() => activityExpiry.sync());
    activityExpiry.connect();
    return () => {
      stop();
      activityExpiry.disconnect();
    };
  });
  function ModeTabs() {
    return (
      <HubTabs
        id="activity-mode"
        active={route()?.mode ?? "sessions"}
        tabs={[
          { value: "sessions", label: t("activityFeed.sessionsMode") },
          { value: "live", label: t("activity.runInspector.liveMode") },
        ]}
        ariaLabel={t("activity.runInspector.activityView")}
        panelId="activity-mode-panel"
        class="activity-mode-tabs"
        variant="sub"
        onSelect={(selected) =>
          state().context.navigate("activity", {
            search: selected === "live" ? "?view=live" : "",
          })
        }
      />
    );
  }

  function LiveActivityView(liveProps: {
    basePath: string;
    entries: readonly ActivityEntry[];
    children?: JSX.Element;
  }) {
    onSettled(() => {
      // Wait for insertion, then capture both responsive owners within the page.
      const root = stream?.closest<HTMLElement>("main.content") ?? stream;
      return root
        ? listen(
            root,
            "scroll",
            (event) => {
              if (event.target === scrollContainer()) {
                follow.handleScroll();
              }
            },
            true,
          )
        : undefined;
    });
    function StatusFilter(props: { status: ActivityStatus }) {
      return (
        <button
          type="button"
          class="btn btn--sm activity-status-filter"
          data-status={props.status}
          aria-pressed={filters.statusFilters[props.status] ? "true" : "false"}
          onClick={() =>
            update({
              statusFilters: {
                ...filters.statusFilters,
                [props.status]: !filters.statusFilters[props.status],
              },
            })
          }
        >
          {t(`activity.status.${props.status}`)}
        </button>
      );
    }

    function StatusFilters() {
      return (
        <span role="group" aria-label={t("activity.statusFilters")} class="activity-status-filters">
          <For each={STATUS_ORDER}>{(status) => <StatusFilter status={status} />}</For>
        </span>
      );
    }

    function AutoFollow() {
      return (
        <span class="activity-live-autofollow">
          <span>{t("activity.autoFollow")}</span>
          <SettingsToggle
            checked={filters.autoFollow}
            ariaLabel={t("activity.autoFollow")}
            onChange={(next) => {
              const wasFollowing = filters.autoFollow;
              update({ autoFollow: next });
              if (next && !wasFollowing) {
                follow.schedule(true);
              }
            }}
          />
        </span>
      );
    }

    function ToolFilter(props: { toolNames: string[] }) {
      let popover: PopoverHandle | undefined;
      return (
        <Popover
          id="activity-live-filter-popover"
          triggerId="activity-live-filter-trigger"
          triggerClass={[
            "btn btn--sm btn--ghost activity-live-filter-trigger",
            { active: Boolean(filters.toolFilter) },
          ]}
          triggerTitle={t("activity.filters")}
          trigger={<Icon name="listFilter" />}
          ref={(handle) => {
            popover = handle;
          }}
          label={t("activity.filters")}
          class="activity-live-filter-popover"
          placement="bottom-end"
          onOpenChange={(open) => {
            if (open) {
              popover?.overlay.surface.focus({ preventScroll: true });
            }
          }}
        >
          <div class="activity-live-filter-popover__panel">
            <label class="field">
              <span>{t("activity.toolFilter")}</span>
              <SettingsSelect
                aria-label={t("activity.toolFilter")}
                value={filters.toolFilter}
                onChange={(event) => update({ toolFilter: event.currentTarget.value })}
                options={[
                  { value: "", label: t("activity.allTools") },
                  ...props.toolNames.map((name) => ({ value: name, label: name })),
                ]}
              />
            </label>
          </div>
        </Popover>
      );
    }

    function LiveToolbar(props: { toolNames: string[] }) {
      return (
        <div class="activity-toolbar activity-live-toolbar">
          <ModeTabs />
          <StatusFilters />
          <div class="activity-toolbar__actions">
            <AutoFollow />
            <HeaderSearch
              title={undefined}
              class="activity-toolbar__search activity-live-search"
              label={t("activity.search")}
              placeholder={t("activity.searchPlaceholder")}
              query={filters.filterText}
              open={liveSearchOpen() || Boolean(filters.filterText)}
              onOpenChange={setLiveSearchOpen}
              onQueryChange={(filterText) => update({ filterText })}
            />
            <ToolFilter toolNames={props.toolNames} />
            {actionsMenu()}
          </div>
        </div>
      );
    }

    function ActivityEntryView(props: {
      entry: ActivityEntry;
      formatTimestamp: ReturnType<typeof createMsFormatter>;
      immediate: boolean;
    }) {
      return (
        <details
          class={["activity-entry", `activity-entry--${props.entry.status}`]}
          prop:open={expandedIds().has(props.entry.id)}
          onToggle={(event) =>
            setExpandedIds((ids) => toggle(ids, props.entry.id, event.currentTarget.open))
          }
        >
          <summary class="activity-entry__summary">
            <span class="activity-entry__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
            <span class="activity-entry__main">
              <span class="activity-entry__title">
                <SettingsStatus
                  kind={STATUS_KINDS[props.entry.status]}
                  label={t(`activity.status.${props.entry.status}`)}
                />
                <span class="activity-entry__tool mono">{entryLabel(props.entry)}</span>
              </span>
              <span class="activity-entry__text">{buildEntrySummary(props.entry)}</span>
            </span>
            <span class="activity-entry__meta">
              <span>{props.formatTimestamp(props.entry.updatedAt)}</span>
              <span>{formatDuration(props.entry.durationMs)}</span>
            </span>
          </summary>
          <Show when={props.immediate || remainderReady() || expandedIds().has(props.entry.id)}>
            <div class="activity-entry__body">
              <div class="activity-entry__facts">
                {props.entry.entryKind === "answer_candidate" ? (
                  <span class="mono">
                    {t("activity.answerCandidate.itemId")}: {props.entry.itemId}
                  </span>
                ) : (
                  <>
                    <span>{hiddenArgumentsLabel(props.entry.hiddenArgumentCount)}</span>
                    <span class="mono">
                      {t("activity.toolCallId")}: {props.entry.toolCallId}
                    </span>
                  </>
                )}
                <a
                  class="activity-entry__run-link mono"
                  href={activityRunInspectorHref(props.entry.runId, liveProps.basePath)}
                >
                  {t("activity.runId")}: {props.entry.runId}
                </a>
                {props.entry.sessionKey ? (
                  <span class="mono">
                    {t("activity.session")}: {props.entry.sessionKey}
                  </span>
                ) : undefined}
              </div>
              {props.entry.outputPreview ? (
                <>
                  <pre class="activity-entry__preview">{props.entry.outputPreview}</pre>
                  {props.entry.outputTruncated ? (
                    <div class="activity-entry__note">{t("activity.outputTruncated")}</div>
                  ) : undefined}
                </>
              ) : (
                <div class="activity-entry__note">{t("activity.noOutputPreview")}</div>
              )}
            </div>
          </Show>
        </details>
      );
    }

    const formatTimestamp = createMemo(() => {
      // A locale change replaces the formatter while keeping stream rows mounted.
      getLocale();
      return createMsFormatter({ hour: "numeric", minute: "2-digit", second: "2-digit" }, "");
    });
    const toolNames = createMemo(
      () => sortUniqueStrings(liveProps.entries.map((entry) => entry.toolName)),
      {
        equals: (a, b) => a.length === b.length && a.every((name, index) => name === b[index]),
      },
    );
    const filtered = createMemo(() => {
      const needle = normalizeLowercaseStringOrEmpty(filters.filterText).normalize("NFC");
      return liveProps.entries.filter(
        (entry) =>
          filters.statusFilters[entry.status] &&
          (!filters.toolFilter || entry.toolName === filters.toolFilter) &&
          matchesEntry(entry, needle),
      );
    });
    const hasEntries = createMemo(() => filtered().length > 0);
    const expandAll = () => setExpandedIds(new Set(liveProps.entries.map((entry) => entry.id)));
    const collapseAll = () => setExpandedIds(new Set<string>());
    const clearAll = () => pageProps.page.clearLiveActivity();
    // Summaries preserve exact closed-row geometry. Populate offscreen bodies
    // after a task boundary; either end stays ready for the first screen/follow.
    const remainderReady = createDeferred(
      () => (hasEntries() ? yieldActivityRender().then(() => true) : false),
      { loadingValue: false },
    );

    const actionsMenu = () => (
      <Menu
        id="activity-live-actions"
        pointerFocus="trigger"
        label={t("browser.moreActions")}
        placement="bottom-end"
        trigger={<Icon name="moreHorizontal" />}
        triggerClass="btn btn--sm btn--ghost activity-live-actions__trigger"
        triggerAttributes={{ title: t("browser.moreActions") }}
        items={[
          {
            id: "expand",
            label: t("activity.expandAll"),
            disabled: filtered().length === 0,
          },
          {
            id: "collapse",
            label: t("activity.collapseAll"),
            disabled: expandedIds().size === 0,
          },
          {
            id: "clear",
            label: t("activity.clear"),
            variant: "danger",
            disabled: liveProps.entries.length === 0,
          },
        ]}
        onSelect={(item) => {
          if (item.id === "expand") {
            expandAll();
          } else if (item.id === "collapse") {
            collapseAll();
          } else if (item.id === "clear") {
            clearAll();
          }
        }}
      />
    );

    // The stream fills the remaining viewport height; the settings-page column
    // wrapper is intentionally skipped so the fill-height flex chain
    // (.settings-workspace--fill-height … .activity-page … .activity-group …
    // .activity-stream) works. The named <section> keeps the region landmark.
    return (
      <>
        <LiveToolbar toolNames={toolNames()} />
        {liveProps.children}
        <section class="activity-page" aria-label={t("activity.title")}>
          <div class="settings-section__header">
            <h2 class="settings-section__heading">{t("activity.title")}</h2>
            <div class="settings-section__actions">
              <span class="activity-count" aria-live="polite">
                {t("activity.visibleCount", {
                  visible: String(filtered().length),
                  total: String(liveProps.entries.length),
                })}
              </span>
            </div>
          </div>
          <div class="settings-group activity-group">
            <div
              class="activity-stream"
              ref={(element) => {
                stream = element;
              }}
              role="group"
              aria-label={t("activity.streamLabel")}
            >
              {filtered().length === 0 ? (
                <div class="activity-empty">
                  {liveProps.entries.length === 0 ? (
                    <div>
                      <p>{t("activity.empty")}</p>
                      <p>{t("activity.emptyDescription")}</p>
                    </div>
                  ) : (
                    t("activity.emptyFiltered")
                  )}
                </div>
              ) : (
                <For each={filtered()} keyed={(entry) => entry.id}>
                  {(entry, index) => (
                    <ActivityEntryView
                      entry={entry()}
                      formatTimestamp={formatTimestamp()}
                      immediate={index() < 10 || index() >= filtered().length - 10}
                    />
                  )}
                </For>
              )}
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <Show when={Boolean(route() && location())} fallback={<LoadingState />}>
      <ShellLayoutBoundary traits={{ activityPage: true }}>
        <HubPageHeader
          active="activity"
          wide
          docsUrl="https://docs.openclaw.ai/web/control-ui/settings#activity-tab"
        />
      </ShellLayoutBoundary>
      <SettingsWorkspace fillHeight>
        <div
          id="activity-mode-panel"
          role={route()?.mode === "run" ? undefined : "tabpanel"}
          aria-labelledby={
            route()?.mode === "run" ? undefined : `activity-mode-tab-${route()?.mode}`
          }
        >
          <Switch>
            <Match when={route()?.mode === "sessions"}>
              <SessionActivityView
                toolbarLeading={<ModeTabs />}
                expandedAutomationDays={expandedAutomationDays()}
                filters={{
                  ...(sessionRoute()?.filters ?? {
                    personId: null,
                    query: "",
                    time: "7d" as const,
                  }),
                  personId:
                    state().sessionActivity.result?.involvingProfileId ??
                    sessionRoute()?.filters.personId ??
                    null,
                }}
                presenceViewers={presence()}
                presentationRevision={pageRevision() + presentationTime()}
                result={state().sessionActivity.result}
                read={state().sessionActivity.read}
                loading={pending()}
                retrying={state().sessionActivity.retrying}
                error={state().sessionActivity.error}
                onRetry={() => pageProps.page.syncSessionActivity("retry")}
                onSummaryRetry={
                  canCallGatewayMethod(
                    state().context.gateway.snapshot,
                    ACTIVITY_SUMMARY_ENSURE_METHOD,
                    "operator.write",
                    { requireAdvertisement: false },
                  )
                    ? (row) => state().sessionActivity.retrySummary(row)
                    : undefined
                }
                onAutomationDayToggle={(day) =>
                  setExpandedAutomationDays((days) => toggle(days, day))
                }
                onFiltersChange={(nextFilters) =>
                  state().context.navigate(
                    "activity",
                    state().sessionActivity.locationForFilters(
                      nextFilters,
                      location()!,
                      state().context.basePath,
                      presence(),
                    ),
                  )
                }
              />
            </Match>
            <Match when={route()?.mode === "run"}>
              <Show when={!pending()} fallback={<LoadingState />}>
                <a
                  class="activity-run-inspector-back"
                  href={pathForRoute("activity", state().context.basePath)}
                >
                  <Icon name="arrowLeft" />
                  {t("activityFeed.backToSessions")}
                </a>
                <RunInspector
                  basePath={state().context.basePath}
                  connected={state().context.gateway.snapshot.phase === "connected"}
                  state={state().runInspector}
                  request={state().inspectorRead}
                  selector={runRoute()?.selector ?? null}
                  selectorId={runRoute()?.selectorId ?? null}
                  onLoadMoreExecutions={() => pageProps.page.loadMoreInspectorPage("executions")}
                  onLoadMoreDecisions={() => pageProps.page.loadMoreInspectorPage("decisions")}
                  onRestart={() => pageProps.page.restartRunInspector()}
                  onRetry={() =>
                    pageProps.page.syncRunInspector(
                      state().context.gateway,
                      state().context.gateway.snapshot,
                      true,
                    )
                  }
                />
              </Show>
            </Match>
            <Match when={route()?.mode === "live"}>
              <div id="activity-live-panel">
                <LiveActivityView
                  basePath={state().context.basePath}
                  entries={liveSnapshot().entries}
                >
                  <CurrentWork
                    basePath={state().context.basePath}
                    fallbackAgentId={resolveUiDefaultAgentId(sessionHost())}
                    mainKey={resolveUiConfiguredMainKey(sessionHost())}
                    globalScope={isUiGlobalScopeConfigured(sessionHost())}
                    navigate={state().context.navigate}
                    connected={state().context.gateway.snapshot.phase === "connected"}
                    result={state().sessionActivity.result}
                    read={state().sessionActivity.read}
                    loading={pending() || state().sessionActivity.incomplete}
                    incomplete={state().sessionActivity.incomplete}
                    error={state().sessionActivity.error}
                    onRetry={() => pageProps.page.syncSessionActivity("retry")}
                  />
                  <Show when={liveSnapshot().error}>
                    <div role="alert">
                      <SettingsStatus kind="danger" label={liveSnapshot().error ?? ""} />
                      <button
                        type="button"
                        class="btn btn--sm"
                        onClick={() => pageProps.page.retryLiveActivity()}
                      >
                        {t("common.retry")}
                      </button>
                    </div>
                  </Show>
                </LiveActivityView>
              </div>
            </Match>
          </Switch>
        </div>
      </SettingsWorkspace>
    </Show>
  );
}
