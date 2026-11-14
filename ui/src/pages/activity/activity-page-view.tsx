// Preserve stylesheet evaluation order across the folded view imports.
import "../../styles/tabs.css";
import "../../styles/hub-tabs.css";
import "../../styles/settings.css";
import "./run-inspector.css";
import "../../components/theme-brand-icon.css";
import "../../styles/identity-avatar.css";
import "../../styles/agent-row-chip.css";
import { createMemo, createSignal, Match, onSettled, Show, Switch } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import { projectPresencePayload } from "../../lib/presence-users.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
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
import "../../styles/activity.css";

registerEnglishCatalog(registerActivityEnglish);

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
  const pageRevision = () => pageProps.page.revision() + pageProps.page.agents.revision();
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
              </div>
            </Match>
          </Switch>
        </div>
      </SettingsWorkspace>
    </Show>
  );
}
