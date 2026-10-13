import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { renderHubTabs } from "../../components/hub-tabs.ts";
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
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { ActivityPageController } from "./activity-page-controller.ts";
import { renderCurrentWork as CurrentWork } from "./current-work-view.tsx";
import { renderRunInspector as RunInspector } from "./run-inspector-view.tsx";
import { ACTIVITY_SUMMARY_ENSURE_METHOD } from "./session-activity-controller.ts";
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

export function ActivityPageView(props: {
  controller: ActivityPageController;
  revision: () => number;
  host?: HTMLElement;
}) {
  const state = () => {
    props.revision();
    return props.controller;
  };
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
    agentsList: state().context.agents.state.agentsList,
    hello: state().context.gateway.snapshot.hello,
  });
  const update = (
    patch: Partial<
      Pick<
        ActivityPageController,
        | "filterText"
        | "toolFilter"
        | "statusFilters"
        | "autoFollow"
        | "expandedIds"
        | "expandedAutomationDays"
      >
    >,
  ) => {
    Object.assign(props.controller, patch);
    props.controller.requestUpdate();
  };
  let frame: number | undefined;
  let previousEntries = untrack(() => props.controller.entries);
  let previousAutoFollow = untrack(() => props.controller.autoFollow);
  const follow = createMemo(() => ({ entries: state().entries, enabled: state().autoFollow }), {
    equals: (previous, next) =>
      previous.entries === next.entries && previous.enabled === next.enabled,
  });
  createEffect(follow, ({ entries, enabled }) => {
    const force = enabled && !previousAutoFollow;
    const appended = entries !== previousEntries;
    previousEntries = entries;
    previousAutoFollow = enabled;
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
    if (!props.host || (!force && (!enabled || !appended || !props.controller.atBottom))) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const container = props.host?.querySelector<HTMLElement>(".activity-stream");
      if (!container) {
        return;
      }
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (
        !force &&
        (!props.controller.autoFollow || (!props.controller.atBottom && distance >= 120))
      ) {
        return;
      }
      container.scrollTop = container.scrollHeight;
      props.controller.atBottom = true;
    });
  });
  const [visible, setVisible] = createSignal(document.visibilityState !== "hidden");
  const visibilityChanged = () => {
    setVisible(document.visibilityState !== "hidden");
    if (document.visibilityState !== "hidden") {
      props.controller.requestUpdate();
    }
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  const expiry = createMemo(() => {
    props.revision();
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
  createEffect(expiry, (deadline) => {
    if (deadline === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => props.controller.requestUpdate(),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  });
  onCleanup(() => {
    document.removeEventListener("visibilitychange", visibilityChanged);
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
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
          <LitContent
            render={() =>
              renderHubTabs({
                id: "activity-mode",
                active: route()?.mode ?? "sessions",
                tabs: [
                  { value: "sessions", label: t("activityFeed.sessionsMode") },
                  { value: "live", label: t("activity.runInspector.liveMode") },
                ],
                ariaLabel: t("activity.runInspector.activityView"),
                panelId: "activity-mode-panel",
                className: "activity-mode-tabs",
                variant: "sub",
                onSelect: (selected) =>
                  state().context.navigate("activity", {
                    search: selected === "live" ? "?view=live" : "",
                  }),
              })
            }
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
                expandedAutomationDays={state().expandedAutomationDays}
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
                presentationRevision={props.revision()}
                result={state().sessionActivity.result}
                loading={pending() || state().sessionActivity.loading}
                retrying={state().sessionActivity.retrying}
                error={state().sessionActivity.error}
                onRetry={() => state().syncSessionActivity("retry")}
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
                  update({ expandedAutomationDays: toggle(state().expandedAutomationDays, day) })
                }
                onFiltersChange={(filters) =>
                  state().context.navigate(
                    "activity",
                    state().sessionActivity.locationForFilters(
                      filters,
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
                  onLoadMoreExecutions={() => state().loadMoreInspectorPage("executions")}
                  onLoadMoreDecisions={() => state().loadMoreInspectorPage("decisions")}
                  onRestart={() => state().restartRunInspector()}
                  onRetry={() =>
                    state().syncRunInspector(
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
                  onRetry={() => state().syncSessionActivity("retry")}
                />
                <Show when={state().liveActivity?.snapshot.error}>
                  <div role="alert">
                    <SettingsStatus
                      kind="danger"
                      label={state().liveActivity?.snapshot.error ?? ""}
                    />
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => state().liveActivity?.retry()}
                    >
                      {t("common.retry")}
                    </button>
                  </div>
                </Show>
                <LiveActivityView
                  basePath={state().context.basePath}
                  entries={state().entries}
                  filterText={state().filterText}
                  statusFilters={state().statusFilters}
                  toolFilter={state().toolFilter}
                  expandedIds={state().expandedIds}
                  autoFollow={state().autoFollow}
                  onFilterTextChange={(next) => update({ filterText: next })}
                  onToolFilterChange={(next) => update({ toolFilter: next })}
                  onStatusToggle={(status, enabled) =>
                    update({ statusFilters: { ...state().statusFilters, [status]: enabled } })
                  }
                  onToggleAutoFollow={(next) => update({ autoFollow: next })}
                  onClear={() => state().liveActivity?.clear()}
                  onExpandAll={() =>
                    update({ expandedIds: new Set(state().entries.map((entry) => entry.id)) })
                  }
                  onCollapseAll={() => update({ expandedIds: new Set() })}
                  onEntryToggle={(id, open) =>
                    update({ expandedIds: toggle(state().expandedIds, id, open) })
                  }
                  onScroll={(event) => {
                    const container = event.currentTarget;
                    props.controller.atBottom =
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
