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
import {
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
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { SettingsStatus, SettingsToggle } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import { projectPresencePayload } from "../../lib/presence-users.ts";
import { t, getLocale, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
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
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";
import "../../styles/activity.css";

registerEnglishCatalog(registerActivityEnglish);

const STATUS_ORDER: ActivityStatus[] = ["running", "done", "error"];

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
  );
  return haystack.includes(needle);
}

const STATUS_KINDS = { running: "warn", done: "ok", error: "danger" } as const satisfies Record<
  ActivityStatus,
  "warn" | "ok" | "danger"
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
  let stream: HTMLDivElement | undefined;
  const follow = useStreamAutoFollow({
    container: () => stream,
    enabled: () => filters.autoFollow,
    identity: liveRevision,
  });
  onSettled(() => {
    let previous = liveSnapshot();
    // Ordered append/reset receipts preserve stream-follow intent across each publication.
    return pageProps.page.liveActivity.subscribe(() => {
      const current = liveSnapshot();
      if (current.revision !== previous.revision) {
        follow.reset();
      }
      const appended = current.entries !== previous.entries;
      previous = current;
      if (filters.autoFollow && appended) {
        follow.schedule();
      }
    });
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
  function LiveActivityView(liveProps: { basePath: string; entries: readonly ActivityEntry[] }) {
    function StatusFilter(props: { status: ActivityStatus }) {
      return (
        <label class="activity-status-filter">
          <input
            type="checkbox"
            checked={filters.statusFilters[props.status]}
            onChange={(event) =>
              update({
                statusFilters: {
                  ...filters.statusFilters,
                  [props.status]: event.currentTarget.checked,
                },
              })
            }
          />
          <span>{t(`activity.status.${props.status}`)}</span>
        </label>
      );
    }

    function ToolFilter(props: { toolNames: string[] }) {
      let popover: PopoverHandle | undefined;
      return (
        <Popover
          id="activity-live-filter-popover"
          triggerId="activity-live-filter-trigger"
          triggerClass={[
            "btn btn--sm activity-live-filter-trigger",
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
              <select
                class="settings-select"
                aria-label={t("activity.toolFilter")}
                value={filters.toolFilter}
                onChange={(event) => update({ toolFilter: event.currentTarget.value })}
              >
                <option value="" selected={filters.toolFilter === ""}>
                  {t("activity.allTools")}
                </option>
                <For each={props.toolNames}>
                  {(name) => (
                    <option value={name} selected={name === filters.toolFilter}>
                      {name}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </div>
        </Popover>
      );
    }

    function LiveToolbar(props: { toolNames: string[] }) {
      return (
        <div class="activity-live-toolbar">
          <div class="activity-feed__search activity-live-search">
            <span aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              class="settings-input"
              type="search"
              aria-label={t("activity.search")}
              value={filters.filterText}
              placeholder={t("activity.searchPlaceholder")}
              onInput={(event) => update({ filterText: event.currentTarget.value })}
            />
          </div>
          <span
            role="group"
            aria-label={t("activity.statusFilters")}
            class="activity-status-filters"
          >
            <For each={STATUS_ORDER}>{(status) => <StatusFilter status={status} />}</For>
          </span>
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
          <ToolFilter toolNames={props.toolNames} />
        </div>
      );
    }

    function ActivityEntryView(props: {
      entry: ActivityEntry;
      formatTimestamp: ReturnType<typeof createMsFormatter>;
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
      const needle = normalizeLowercaseStringOrEmpty(filters.filterText);
      return liveProps.entries.filter(
        (entry) =>
          filters.statusFilters[entry.status] &&
          (!filters.toolFilter || entry.toolName === filters.toolFilter) &&
          matchesEntry(entry, needle),
      );
    });

    // The stream fills the remaining viewport height; the settings-page column
    // wrapper is intentionally skipped so the fill-height flex chain
    // (.settings-workspace--fill-height … .activity-page … .activity-group …
    // .activity-stream) works. The named <section> keeps the region landmark.
    return (
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
            <button
              type="button"
              class="btn btn--sm"
              disabled={filtered().length === 0}
              onClick={() => setExpandedIds(new Set(liveProps.entries.map((entry) => entry.id)))}
            >
              {t("activity.expandAll")}
            </button>
            <button
              type="button"
              class="btn btn--sm"
              disabled={expandedIds().size === 0}
              onClick={() => setExpandedIds(new Set())}
            >
              {t("activity.collapseAll")}
            </button>
            <button
              type="button"
              class="btn btn--sm danger"
              disabled={liveProps.entries.length === 0}
              onClick={() => pageProps.page.clearLiveActivity()}
            >
              {t("activity.clear")}
            </button>
          </div>
        </div>
        <div class="settings-group activity-group">
          <LiveToolbar toolNames={toolNames()} />
          <div
            class="activity-stream"
            ref={(element) => {
              stream = element;
            }}
            role="group"
            aria-label={t("activity.streamLabel")}
            onScroll={follow.handleScroll}
          >
            {filtered().length === 0 ? (
              <div class="activity-empty">
                {liveProps.entries.length === 0 ? t("activity.empty") : t("activity.emptyFiltered")}
              </div>
            ) : (
              <For each={filtered()} keyed={(entry) => entry.id}>
                {(entry) => (
                  <ActivityEntryView entry={entry()} formatTimestamp={formatTimestamp()} />
                )}
              </For>
            )}
          </div>
        </div>
      </section>
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
                loading={pending() || state().sessionActivity.loading}
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
                  loading={pending() || state().sessionActivity.loading}
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
                <LiveActivityView
                  basePath={state().context.basePath}
                  entries={liveSnapshot().entries}
                />
              </div>
            </Match>
          </Switch>
        </div>
      </SettingsWorkspace>
    </Show>
  );
}
