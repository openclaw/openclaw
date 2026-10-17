import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  PRESENCE_ACTIVE_WINDOW_MS,
  presenceViewerLastActivity,
  projectPresencePayload,
} from "../../lib/presence-users.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import type { ActivityPageState } from "./activity-page-state.ts";
import { renderCurrentWork as CurrentWork } from "./current-work-view.tsx";
import { renderRunInspector as RunInspector } from "./run-inspector-view.tsx";
import { ACTIVITY_SUMMARY_ENSURE_METHOD } from "./session-activity-owner.ts";
import { renderSessionActivityView as SessionActivityView } from "./session-activity-view.tsx";
import { renderActivity as LiveActivityView } from "./view.tsx";

function toggle(ids: ReadonlySet<string>, id: string, open = !ids.has(id)) {
  const next = new Set(ids);
  if (open) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

export function ActivityPageView(props: { page: ActivityPageState }) {
  const state = () => props.page.read();
  const liveSnapshot = () => props.page.liveActivity.read();
  const pageRevision = () =>
    props.page.revision() + props.page.liveActivity.revision() + props.page.agents.revision();
  const [filters, setFilters] = createStore({
    filterText: "",
    toolFilter: "",
    autoFollow: true,
    statusFilters: { running: true, done: true, error: true },
  });
  const update = (patch: Partial<typeof filters>) =>
    setFilters((draft) => Object.assign(draft, patch));
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
    agentsList: props.page.agents.read().agentsList,
    hello: state().context.gateway.snapshot.hello,
  });
  let stream: HTMLDivElement | undefined;
  let atBottom = true;
  let previousRevision = -1;
  let previousEntries: ReturnType<ActivityPageState["liveActivity"]["read"]>["entries"] | undefined;
  let previousAutoFollow = true;
  const follow = createMemo(
    () => ({
      entries: liveSnapshot().entries,
      enabled: filters.autoFollow,
      revision: liveRevision(),
    }),
    {
      equals: (previous, next) =>
        previous.entries === next.entries &&
        previous.enabled === next.enabled &&
        previous.revision === next.revision,
    },
  );
  // Keep the live stream DOM at the bottom while the reader is following it.
  createEffect(follow, ({ entries, enabled, revision }) => {
    if (revision !== previousRevision) {
      atBottom = true;
      previousRevision = revision;
    }
    const force = enabled && !previousAutoFollow;
    const appended = previousEntries !== undefined && entries !== previousEntries;
    previousEntries = entries;
    previousAutoFollow = enabled;
    if (!force && (!enabled || !appended || !atBottom)) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      const container = stream;
      if (!container?.isConnected) {
        return;
      }
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (!force && (!filters.autoFollow || (!atBottom && distance >= 120))) {
        return;
      }
      container.scrollTop = container.scrollHeight;
      atBottom = true;
    });
    return () => cancelAnimationFrame(frame);
  });
  const [presentationTime, setPresentationTime] = createSignal(Date.now());
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  const visibilityChanged = () => {
    setVisible(document.visibilityState !== "hidden");
    if (document.visibilityState !== "hidden") {
      setPresentationTime(Date.now());
    }
  };
  onSettled(() => listen(document, "visibilitychange", visibilityChanged));
  const expiry = createMemo(() => {
    pageRevision();
    presentationTime();
    if (!visible()) {
      return undefined;
    }
    const now = Date.now();
    const deadlines = presence().flatMap((viewer) => {
      const activity = presenceViewerLastActivity(viewer);
      const deadline = activity === undefined ? undefined : activity + PRESENCE_ACTIVE_WINDOW_MS;
      return deadline !== undefined && deadline > now ? [deadline] : [];
    });
    return deadlines.length ? Math.min(...deadlines) : undefined;
  });
  // The browser clock expires presence even when no Gateway event arrives.
  createEffect(expiry, (deadline) => {
    if (deadline === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => setPresentationTime(Date.now()),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  });
  return (
    <Show when={Boolean(route() && location())} fallback={<LoadingState />}>
      <ShellLayoutBoundary traits={{ toolbarHeader: true, activityPage: true }}>
        <section class="content-header">
          <div>
            <div class="page-title">{titleForRoute("activity")}</div>
            <Show when={route()?.mode !== "live"}>
              <div class="page-sub">{t("subtitles.activity")}</div>
            </Show>
          </div>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace fillHeight>
        <Show when={route()?.mode !== "run"}>
          <HubTabs
            {...{
              id: "activity-mode",
              active: route()?.mode ?? "sessions",
              tabs: [
                { value: "sessions", label: t("activityFeed.sessionsMode") },
                { value: "live", label: t("activity.runInspector.liveMode") },
              ],
              ariaLabel: t("activity.runInspector.activityView"),
              panelId: "activity-mode-panel",
              class: "activity-mode-tabs",
              variant: "sub",
              onSelect: (selected) =>
                state().context.navigate("activity", {
                  search: selected === "live" ? "?view=live" : "",
                }),
            }}
          />
        </Show>
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
                context={state().context}
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
                loading={pending() || state().sessionActivity.loading}
                retrying={state().sessionActivity.retrying}
                error={state().sessionActivity.error}
                onRetry={() => props.page.syncSessionActivity("retry")}
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
                  state={state().runInspector}
                  selector={runRoute()?.selector ?? null}
                  selectorId={runRoute()?.selectorId ?? null}
                  onLoadMoreExecutions={() => props.page.loadMoreInspectorPage("executions")}
                  onLoadMoreDecisions={() => props.page.loadMoreInspectorPage("decisions")}
                  onRestart={() => props.page.restartRunInspector()}
                  onRetry={() =>
                    props.page.syncRunInspector(
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
                <CurrentWork
                  basePath={state().context.basePath}
                  fallbackAgentId={resolveUiDefaultAgentId(sessionHost())}
                  mainKey={resolveUiConfiguredMainKey(sessionHost())}
                  globalScope={isUiGlobalScopeConfigured(sessionHost())}
                  navigate={state().context.navigate}
                  connected={state().context.gateway.snapshot.phase === "connected"}
                  result={state().sessionActivity.result}
                  loading={pending() || state().sessionActivity.loading}
                  incomplete={state().sessionActivity.incomplete}
                  error={state().sessionActivity.error}
                  onRetry={() => props.page.syncSessionActivity("retry")}
                />
                <Show when={liveSnapshot().error}>
                  <div role="alert">
                    <SettingsStatus kind="danger" label={liveSnapshot().error ?? ""} />
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => props.page.retryLiveActivity()}
                    >
                      {t("common.retry")}
                    </button>
                  </div>
                </Show>
                <LiveActivityView
                  basePath={state().context.basePath}
                  entries={liveSnapshot().entries}
                  filterText={filters.filterText}
                  statusFilters={filters.statusFilters}
                  toolFilter={filters.toolFilter}
                  expandedIds={expandedIds()}
                  autoFollow={filters.autoFollow}
                  onFilterTextChange={(next) => update({ filterText: next })}
                  onToolFilterChange={(next) => update({ toolFilter: next })}
                  onStatusToggle={(status, enabled) =>
                    update({ statusFilters: { ...filters.statusFilters, [status]: enabled } })
                  }
                  onToggleAutoFollow={(next) => update({ autoFollow: next })}
                  onClear={() => props.page.clearLiveActivity()}
                  onExpandAll={() =>
                    setExpandedIds(new Set(liveSnapshot().entries.map((entry) => entry.id)))
                  }
                  onCollapseAll={() => setExpandedIds(new Set())}
                  onEntryToggle={(id, open) => setExpandedIds((ids) => toggle(ids, id, open))}
                  onStream={(element) => {
                    stream = element;
                  }}
                  onScroll={(event) => {
                    const container = event.currentTarget;
                    atBottom =
                      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
                  }}
                />
              </div>
            </Match>
          </Switch>
        </div>
      </SettingsWorkspace>
    </Show>
  );
}
