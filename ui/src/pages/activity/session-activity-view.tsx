import type { JSX } from "@solidjs/web";
import {
  createDeferred,
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
} from "solid-js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { IpLocation } from "../../components/ip-location.tsx";
import { HeaderSearch } from "../../components/solid/header-search.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { formatUiError } from "../../lib/format-error.ts";
import "../../components/solid/viewer-facepile.tsx";
import { formatTimeAgo } from "../../lib/format.ts";
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
import { registerEnglishCatalog, getLocale, t } from "../../lib/reactive/i18n.ts";
import { PeopleControl, PersonFilterChip } from "./session-activity-people.tsx";
import { renderSessionActivityPulse as SessionActivityPulse } from "./session-activity-pulse.tsx";
import { SessionLinkView } from "./session-activity-row.tsx";
import {
  ACTIVITY_TIME_FILTERS,
  TIME_LABELS,
  projectSessionActivity,
  resolveViewingNow,
  type SessionActivityFilters,
} from "./session-activity.ts";

registerEnglishCatalog(registerActivityEnglish);

export type SessionActivityViewProps = {
  toolbarLeading?: JSX.Element;
  expandedAutomationDays: ReadonlySet<string>;
  filters: SessionActivityFilters;
  presenceViewers: readonly PresenceViewer[];
  presentationRevision?: number;
  result?: SessionsListResult;
  read?: { promise: Promise<void> };
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
                <SessionLinkView row={row()} presentationRevision={props.presentationRevision} />
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
                  {group().entry.ip ? <IpLocation ip={group().entry.ip} /> : undefined}
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
  const [searchOpen, setSearchOpen] = createSignal(false);
  const request = createMemo(() => props.read);
  // Keep accepted rows and scope changes live while their next read settles.
  const read = createDeferred(() => request()?.promise);
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
  function feedback(error: string | undefined, pending: boolean) {
    return (
      <>
        <span role={error ? "alert" : "status"} title={error}>
          {error ?? (props.retrying && pending ? t("common.refreshing") : undefined)}
        </span>
        <Show when={Boolean(error || props.retrying)}>
          <button class="btn btn--sm" disabled={pending} onClick={() => props.onRetry()}>
            {t("common.retry")}
          </button>
        </Show>
      </>
    );
  }
  return (
    <div class="activity-feed">
      <div class="activity-toolbar activity-feed__toolbar">
        {props.toolbarLeading}
        <div class="activity-toolbar__actions">
          <SettingsSegmented
            mode="buttons"
            class="activity-feed__time-filter"
            value={props.filters.time}
            ariaLabel={t("activityFeed.time")}
            options={ACTIVITY_TIME_FILTERS.map((time) => ({
              value: time,
              label: time === "all" ? t("activityFeed.timeAllShort") : time,
              ariaLabel: t(TIME_LABELS[time]),
              title: t(TIME_LABELS[time]),
            }))}
            onChange={(time) => props.onFiltersChange({ ...props.filters, time })}
            onReselect={(time) => props.onFiltersChange({ ...props.filters, time })}
          />
          <HeaderSearch
            title=""
            class="activity-toolbar__search activity-feed__search"
            label={t("activityFeed.searchPlaceholder")}
            query={props.filters.query}
            open={searchOpen() || Boolean(props.filters.query)}
            onOpenChange={setSearchOpen}
            onQueryChange={(query) => props.onFiltersChange({ ...props.filters, query })}
          />
          <PeopleControl
            view={props}
            people={people()}
            selectedPerson={selectedPerson()}
            totalSessions={projection().timeCount}
          />
        </div>
      </div>
      <Show when={selectedPerson()}>
        {(person) => (
          <PersonFilterChip
            person={person()}
            presentationRevision={props.presentationRevision}
            onClear={() => props.onFiltersChange({ ...props.filters, personId: null })}
          />
        )}
      </Show>
      <div class="activity-feed__feedback">
        <Loading on={request()} fallback={feedback(undefined, true)}>
          <Errored
            fallback={(error) => {
              const failure = error();
              return feedback(formatUiError(failure), false);
            }}
          >
            {(latest(read), feedback(props.error, props.loading || isPending(read)))}
          </Errored>
        </Loading>
      </div>
      <div class="activity-feed__main">
        <Errored fallback={() => null}>
          <Loading on={request()} fallback={!props.result ? renderActivityLoading() : undefined}>
            {
              (latest(read),
              (props.loading || isPending(read)) && !props.result
                ? renderActivityLoading()
                : undefined)
            }
          </Loading>
        </Errored>
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
                    <h3 class="settings-section__heading">{dayLabel(day().timestamp)}</h3>
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
