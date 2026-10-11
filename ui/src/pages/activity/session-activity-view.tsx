import { dynamic } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentRowChip } from "../../components/agent-row-chip.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import "../../components/ip-location.ts";
import "../../components/viewer-facepile.ts";
import { formatRelativeTimestamp, formatTimeAgo } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import {
  groupPresenceConnections,
  presenceConnectionDescriptions,
} from "../../lib/presence-connections.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { getLocale, t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  isSessionKeyAddressable,
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  scopedSessionArtifactKey,
} from "../../lib/sessions/session-key.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { activityRunInspectorHref } from "./run-inspector-model.ts";
import { ActivitySessionGit } from "./session-activity-git.tsx";
import { ActivitySessionMedia } from "./session-activity-media.tsx";
import { PeopleControl } from "./session-activity-people.tsx";
import { renderSessionActivityPulse as SessionActivityPulse } from "./session-activity-pulse.tsx";
import { renderSessionActivitySummary as SessionActivitySummary } from "./session-activity-summary.tsx";
import {
  ACTIVITY_TIME_FILTERS,
  TIME_LABELS,
  projectSessionActivity,
  resolveViewingNow,
  sessionActivityOwner,
  type SessionActivityFilters,
} from "./session-activity.ts";

export type SessionActivityViewProps = {
  context: ApplicationContext;
  expandedAutomationDays: ReadonlySet<string>;
  filters: SessionActivityFilters;
  presenceViewers: readonly PresenceViewer[];
  presentationRevision?: number;
  result?: SessionsListResult;
  loading: boolean;
  retrying: boolean;
  error?: string;
  onRetry: () => void;
  onAutomationDayToggle: (dayKey: string) => void;
  onFiltersChange: (filters: SessionActivityFilters) => void;
  onSummaryRetry?: (row: GatewaySessionRow) => void;
};

function dayLabel(timestamp: number | null, now = Date.now()): string {
  getLocale();
  if (timestamp === null) {
    return t("activityFeed.unknownDate");
  }
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const yesterdayDate = new Date(today);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  if (timestamp === today) {
    return t("activityFeed.today");
  }
  if (timestamp === yesterdayDate.getTime()) {
    return t("activityFeed.yesterday");
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(timestamp);
}

function SessionLinkView(props: {
  context: ApplicationContext;
  row: GatewaySessionRow;
  onSummaryRetry?: (row: GatewaySessionRow) => void;
  presentationRevision?: number;
}) {
  const agentId = createMemo(
    () =>
      parseAgentSessionKey(props.row.key)?.agentId ??
      props.row.agentId ??
      resolveSessionNavigationAgentId(props.context),
  );
  const sessionHost = createMemo(() => ({
    agentsList: props.context.agents.state.agentsList,
    hello: props.context.gateway.snapshot.hello,
  }));
  const face = createMemo(() => resolveSessionPreferredFace(props.row));
  const addressable = createMemo(() =>
    isSessionKeyAddressable(props.row.key, isUiGlobalScopeConfigured(sessionHost())),
  );
  const target = createMemo(() =>
    addressable()
      ? sessionNavigationTarget({
          face: face(),
          sessionKey: props.row.key,
          fallbackAgentId:
            props.row.key === "global" ? agentId() : resolveSessionNavigationAgentId(props.context),
          basePath: props.context.basePath,
          row: props.row,
          mainKey: resolveUiConfiguredMainKey(sessionHost()),
        })
      : null,
  );
  const SessionLink = dynamic(() => (target() ? "a" : "div"));
  const ownerName = createMemo(() => {
    getLocale();
    return presenceViewerLabel(sessionActivityOwner(props.row));
  });
  const activityAt = () => sessionActivityTimestamp(props.row);
  const relativeTime = createMemo(() => {
    void props.presentationRevision;
    getLocale();
    return formatRelativeTimestamp(activityAt(), { fallback: "" });
  });
  const activeObserverRunId = createMemo(() => {
    const runId = props.row.observerDigest?.runId;
    return props.row.hasActiveRun === true && runId && props.row.activeRunIds?.includes(runId)
      ? runId
      : undefined;
  });
  const headline = createMemo(() =>
    activeObserverRunId() ? props.row.observerDigest?.headline.trim() : "",
  );
  const scope = createMemo(() =>
    props.row.channel ? t("activityFeed.channelLabel", { value: props.row.channel }) : null,
  );
  const showAgent = () => props.row.kind !== "global" || Boolean(props.row.agentId);
  const source = () => (props.row.createdVia === "cron" ? t("activityFeed.automation") : null);
  return (
    <div
      class={[
        "activity-feed__session-row",
        { "activity-feed__session-row--link": Boolean(target()) },
      ]}
    >
      <SessionLink
        class="activity-feed__session"
        data-activity-session={props.row.key}
        href={target()?.href ?? undefined}
        onClick={(event: MouseEvent) => {
          const destination = target();
          if (destination && shouldHandleNavigationClick(event)) {
            event.preventDefault();
            props.context.navigate(face(), destination.options);
          }
        }}
      >
        <span class="activity-feed__session-avatar">
          {props.row.hasActiveRun === true ? (
            <span class="activity-feed__presence-dot activity-feed__run-dot" aria-hidden="true" />
          ) : undefined}
          <openclaw-viewer-avatar
            prop:identity={props.row.owner?.actor.identity ?? props.row.createdActor?.identity}
            prop:user={sessionActivityOwner(props.row)}
            prop:markAsViewer={false}
            variant="footer"
          />
        </span>
        <span class="activity-feed__session-main">
          <span class="activity-feed__session-title">
            {resolveSessionDisplayName(props.row.key, props.row)}
          </span>
          <span class="activity-feed__session-meta">
            {headline() ? (
              <span
                class="activity-feed__session-headline"
                data-health={props.row.observerDigest?.health ?? undefined}
              >
                {headline()}
              </span>
            ) : (
              <span>{ownerName()}</span>
            )}
            {source() ? (
              <span class="activity-feed__session-source" data-activity-created-via="cron">
                · {source()}
                {scope() || showAgent() ? " ·" : ""}
              </span>
            ) : undefined}
            {showAgent() ? (
              <span class="activity-feed__session-scope">
                <LitContent render={() => renderAgentRowChip(agentId())} />
              </span>
            ) : undefined}
            {scope() ? <span class="activity-feed__session-scope">{scope()}</span> : undefined}
          </span>
        </span>
        <span class="activity-feed__session-time">
          {headline() ? <span class="activity-feed__session-owner">{ownerName()}</span> : undefined}
          {activityAt() > 0 ? <span>{relativeTime()}</span> : undefined}
        </span>
      </SessionLink>
      <SessionActivitySummary row={props.row} onRetry={props.onSummaryRetry} />
      <ActivitySessionGit
        context={props.context}
        sessionKey={scopedSessionArtifactKey(props.row.key, agentId())}
        agentId={agentId()}
      />
      <ActivitySessionMedia
        context={props.context}
        sessionKey={scopedSessionArtifactKey(props.row.key, agentId())}
        agentId={agentId()}
        revision={props.row.updatedAt ?? 0}
        session={props.row}
      />
      <Show when={activeObserverRunId()}>
        {(runId) => (
          <a
            class="activity-feed__inspect-run"
            href={activityRunInspectorHref(runId(), props.context.basePath)}
          >
            {t("activityFeed.inspectRun")}
          </a>
        )}
      </Show>
    </div>
  );
}

function DaySessions(props: {
  view: SessionActivityViewProps;
  day: ReturnType<typeof projectSessionActivity>["days"][number];
}) {
  // GatewaySessionRow.hasAutomation records the enabled cron job binding; titles and keys do not.
  const automation = createMemo(() =>
    props.view.filters.query || props.view.filters.personId
      ? []
      : props.day.sessions.filter((row) => row.hasAutomation === true),
  );
  const grouped = () => automation().length >= 2;
  const regular = createMemo(() =>
    grouped() ? props.day.sessions.filter((row) => row.hasAutomation !== true) : props.day.sessions,
  );
  return (
    <>
      <For each={regular()} keyed={(row) => row.key}>
        {(row) => (
          <SessionLinkView
            context={props.view.context}
            row={row()}
            onSummaryRetry={props.view.onSummaryRetry}
            presentationRevision={props.view.presentationRevision}
          />
        )}
      </For>
      {grouped() ? (
        <>
          <button
            type="button"
            class="activity-feed__session activity-feed__automation-group"
            data-activity-automation-group={props.day.key}
            aria-expanded={props.view.expandedAutomationDays.has(props.day.key) ? "true" : "false"}
            onClick={() => props.view.onAutomationDayToggle(props.day.key)}
          >
            <span class="activity-feed__automation-group-icon" aria-hidden="true">
              <Icon name="clock" />
            </span>
            <span>{t("activityFeed.automationGroup", { count: String(automation().length) })}</span>
            <span class="activity-feed__automation-group-chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </button>
          {props.view.expandedAutomationDays.has(props.day.key) ? (
            <For each={automation()} keyed={(row) => row.key}>
              {(row) => (
                <SessionLinkView
                  context={props.view.context}
                  row={row()}
                  onSummaryRetry={props.view.onSummaryRetry}
                  presentationRevision={props.view.presentationRevision}
                />
              )}
            </For>
          ) : undefined}
        </>
      ) : undefined}
    </>
  );
}

function IdentityHeader(props: {
  context: ApplicationContext;
  identity: PresenceViewer;
  rows: readonly GatewaySessionRow[];
  presentationRevision?: number;
}) {
  const entries = createMemo(() => props.identity.entries ?? []);
  const online = () => entries().length > 0;
  const activity = createMemo(() => {
    void props.presentationRevision;
    return presenceViewerActivity(props.identity);
  });
  const status = () => {
    getLocale();
    return online() ? presenceActivityLabel(activity()) : t("activityFeed.offline");
  };
  const descriptions = createMemo(() => {
    getLocale();
    return presenceConnectionDescriptions(entries());
  });
  const connections = createMemo(() => {
    getLocale();
    return groupPresenceConnections(entries());
  });
  const viewing = createMemo(() => resolveViewingNow(props.identity, props.rows));
  return (
    <section class="activity-feed__identity" data-activity-identity={props.identity.id}>
      <div class="activity-feed__identity-main">
        <openclaw-viewer-avatar
          prop:identity={{ type: "profile", id: props.identity.id }}
          prop:user={props.identity}
          prop:markAsViewer={false}
          variant="profile"
        />
        <div class="activity-feed__identity-copy">
          <h2>{presenceViewerLabel(props.identity)}</h2>
          {props.identity.email ? <p>{props.identity.email}</p> : undefined}
        </div>
        <SettingsStatus
          kind={
            online() && activity() !== "unknown" ? (activity() === "idle" ? "warn" : "ok") : "muted"
          }
          label={status()}
        />
      </div>
      {descriptions().length ? (
        <div class="activity-feed__connection-summary">
          <For each={descriptions()}>{(description) => <span>{description}</span>}</For>
        </div>
      ) : undefined}
      <div class="activity-feed__viewing">
        <h3>{t("activityFeed.viewingNow")}</h3>
        {viewing().length > 0 ? (
          <div class="activity-feed__viewing-list">
            <For each={viewing()} keyed={(row) => row.key}>
              {(row) => (
                <SessionLinkView
                  context={props.context}
                  row={row()}
                  presentationRevision={props.presentationRevision}
                />
              )}
            </For>
          </div>
        ) : (
          <p class="activity-feed__empty-note">{t("activityFeed.notViewing")}</p>
        )}
      </div>
      {entries().length ? (
        <details class="activity-feed__connection-details">
          <summary>
            {t("activityFeed.connectionDetails", { count: String(entries().length) })}
          </summary>
          <div class="activity-feed__connections">
            <For each={connections()} keyed={false}>
              {(group) => (
                <div class="activity-feed__connection">
                  <strong>
                    {group().description ||
                      group().entry.host ||
                      t("activityFeed.unknownConnection")}
                  </strong>
                  <span>
                    {t(
                      group().count === 1
                        ? "activityFeed.connectionOne"
                        : "activityFeed.connectionMany",
                      { count: String(group().count) },
                    )}
                  </span>
                  <span>
                    {[
                      group().entry.host,
                      group().entry.platform,
                      group().entry.ip,
                      group().entry.timeZone,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {group().entry.ip ? (
                    <openclaw-ip-location prop:ip={group().entry.ip} />
                  ) : undefined}
                  {group().entry.lastInputSeconds !== undefined ? (
                    <span>
                      {t("activityFeed.lastInput", {
                        time: formatTimeAgo(group().entry.lastInputSeconds! * 1000, {
                          suffix: false,
                        }),
                      })}
                    </span>
                  ) : undefined}
                </div>
              )}
            </For>
          </div>
        </details>
      ) : undefined}
    </section>
  );
}

function renderActivityLoading() {
  return (
    <section class="activity-feed__loading" aria-busy="true">
      <span class="sr-only" role="status">
        {t("common.loading")}
      </span>
      <div class="skeleton activity-pulse activity-pulse--loading" aria-hidden="true" />
      <div class="activity-feed__sessions" aria-hidden="true">
        {Array.from({ length: 4 }, () => (
          <div class="activity-feed__session-row">
            <div class="activity-feed__session">
              <span class="skeleton activity-feed__loading-avatar" />
              <div class="activity-feed__session-main">
                <div class="skeleton skeleton-line skeleton-line--medium" />
                <div class="skeleton skeleton-line activity-feed__loading-meta" />
              </div>
            </div>
            <div class="activity-feed__recap activity-feed__recap-skeleton">
              <div class="skeleton skeleton-line skeleton-line--long" />
              <div class="skeleton skeleton-line skeleton-line--medium" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function renderSessionActivityView(props: SessionActivityViewProps) {
  const projection = createMemo(() => projectSessionActivity(props.result));
  const onlineById = createMemo(
    () =>
      new Map(
        props.presenceViewers.flatMap((person) =>
          person.identity ? [[person.identity.id, person] as const] : [],
        ),
      ),
  );
  const identity = createMemo(() =>
    props.filters.personId
      ? (onlineById().get(props.filters.personId) ??
        projection().people.find((person) => person.id === props.filters.personId) ??
        null)
      : null,
  );
  const people = createMemo(() =>
    projection().people.map((person) => {
      const online = onlineById().get(person.id);
      return online ? Object.assign({}, person, online, { count: person.count }) : person;
    }),
  );
  const selectedPerson = createMemo(() =>
    props.filters.personId
      ? (people().find((person) => person.id === props.filters.personId) ?? identity())
      : null,
  );
  return (
    <div class="activity-feed">
      <div class="activity-feed__toolbar">
        <label class="data-table-search activity-feed__search">
          <Icon name="search" />
          <input
            type="search"
            aria-label={t("activityFeed.searchPlaceholder")}
            value={props.filters.query}
            placeholder={t("activityFeed.searchPlaceholder")}
            onInput={(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onFiltersChange({ ...props.filters, query: event.currentTarget.value });
              }
            }}
          />
        </label>
        <SettingsSegmented
          mode="buttons"
          class="activity-feed__time-filter"
          value={props.filters.time}
          ariaLabel={t("activityFeed.time")}
          options={ACTIVITY_TIME_FILTERS.map((time) => ({
            value: time,
            label: t(TIME_LABELS[time]),
            ariaLabel: t(TIME_LABELS[time]),
            compactLabel: time === "all" ? t(TIME_LABELS[time]) : time,
          }))}
          onChange={(time) => props.onFiltersChange({ ...props.filters, time })}
          onReselect={(time) => props.onFiltersChange({ ...props.filters, time })}
        />
        <PeopleControl
          view={props}
          people={people()}
          selectedPerson={selectedPerson()}
          totalSessions={projection().timeCount}
        />
      </div>
      <div class="activity-feed__feedback">
        <span role={props.error ? "alert" : "status"} title={props.error ?? undefined}>
          {props.error ?? (props.retrying ? t("common.refreshing") : undefined)}
        </span>
        {Boolean(props.error || props.retrying) ? (
          <button class="btn btn--sm" disabled={props.loading} onClick={props.onRetry}>
            {t("common.retry")}
          </button>
        ) : undefined}
      </div>
      <div class="activity-feed__main">
        {props.loading && !props.result ? renderActivityLoading() : undefined}
        {props.result?.activityPulse ? (
          <SessionActivityPulse
            pulse={props.result.activityPulse}
            time={props.filters.time}
            options={{ peopleIncomplete: props.result.peopleIncomplete }}
          />
        ) : undefined}
        {props.result && props.filters.personId ? (
          identity() ? (
            <For each={identity() ? [identity()!] : []} keyed={(person) => person.id}>
              {(person) => (
                <IdentityHeader
                  context={props.context}
                  identity={person()}
                  rows={projection().sessions}
                  presentationRevision={props.presentationRevision}
                />
              )}
            </For>
          ) : (
            <section class="activity-feed__not-found" role="status">
              <h2>{t("activityFeed.notFoundTitle")}</h2>
              <p>{t("activityFeed.notFoundDescription")}</p>
            </section>
          )
        ) : undefined}
        {props.result && (!props.filters.personId || identity()) ? (
          <>
            {projection().days.length > 0 ? (
              <For each={projection().days} keyed={(day) => day.key}>
                {(day) => (
                  <section class="activity-feed__day">
                    <h3>{dayLabel(day().timestamp)}</h3>
                    <div class="activity-feed__sessions">
                      <DaySessions view={props} day={day()} />
                    </div>
                  </section>
                )}
              </For>
            ) : (
              <section class="activity-feed__empty" role="status">
                {t("activityFeed.noSessions")}
              </section>
            )}
            {projection().matchedCount > projection().sessions.length ? (
              <p class="activity-feed__footer">
                {t("activityFeed.showing", {
                  shown: String(projection().sessions.length),
                  total: String(projection().matchedCount),
                })}
              </p>
            ) : undefined}
          </>
        ) : undefined}
      </div>
    </div>
  );
}
