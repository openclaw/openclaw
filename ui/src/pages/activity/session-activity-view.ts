import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { html as staticHtml, literal } from "lit/static-html.js";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderAgentRowChip } from "../../components/agent-row-chip.ts";
import { icons } from "../../components/icons.ts";
import "../../components/ip-location.ts";
import "../../components/viewer-facepile.ts";
import { renderSettingsStatus, renderSettingsSegmented } from "../../components/settings-ui.ts";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatTimeAgo } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
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
import "./session-activity-git.ts";
import "./session-activity-media.ts";
import { activityRunInspectorHref } from "./run-inspector-model.ts";
import { renderSessionActivityPulse } from "./session-activity-pulse.ts";
import { renderSessionActivitySummary } from "./session-activity-summary.ts";
import {
  ACTIVITY_TIME_FILTERS,
  TIME_LABELS,
  projectSessionActivity,
  resolveViewingNow,
  sessionActivityOwner,
  type SessionActivityFilters,
} from "./session-activity.ts";

type SessionActivityViewProps = {
  context: ApplicationContext;
  expandedAutomationDays: ReadonlySet<string>;
  filters: SessionActivityFilters;
  presenceViewers: readonly PresenceViewer[];
  result?: SessionsListResult;
  loading: boolean;
  retrying: boolean;
  error?: string;
  onRetry: () => void;
  onAutomationDayToggle: (dayKey: string) => void;
  onFiltersChange: (filters: SessionActivityFilters) => void;
  onSummaryRetry?: (row: GatewaySessionRow) => void;
};

type ActivityPerson = PresenceViewer & { count: number };

function isUnresolvedPerson(person: PresenceViewer): boolean {
  return !person.name && !person.email && presenceViewerLabel(person) === person.id;
}

function compactPersonLabel(person: PresenceViewer): string {
  return isUnresolvedPerson(person) && person.id.length > 8
    ? `${person.id.slice(0, 8)}…`
    : presenceViewerLabel(person);
}

function renderPersonAvatar(person: PresenceViewer | null, showPresence = false) {
  if (!person || isUnresolvedPerson(person)) {
    return html`<span
      class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
      aria-hidden="true"
      >${icons.users}</span
    >`;
  }
  return html`<span class="activity-feed__person-avatar">
    <openclaw-viewer-avatar
      .identity=${{ type: "profile", id: person.id }}
      .user=${person}
      .markAsViewer=${false}
      variant="footer"
    ></openclaw-viewer-avatar>
    ${
      showPresence && (person.entries?.length ?? 0) > 0
        ? html`<span
            class="activity-feed__presence-dot"
            data-presence-activity=${presenceViewerActivity(person)}
            role="img"
            aria-label=${presenceActivityLabel(presenceViewerActivity(person))}
          ></span>`
        : nothing
    }
  </span>`;
}

function selectPerson(event: Event, props: SessionActivityViewProps, personId: string | null) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.closest("wa-popover")?.removeAttribute("open");
  }
  props.onFiltersChange({ ...props.filters, personId });
}

function setPeopleExpanded(event: Event, expanded: boolean) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.parentElement
      ?.querySelector(".activity-feed__people-trigger")
      ?.setAttribute("aria-expanded", String(expanded));
  }
}

function renderPersonRow(
  person: ActivityPerson | null,
  props: SessionActivityViewProps,
  count = person?.count,
) {
  const personId = person?.id ?? null;
  return html`<button
    type="button"
    class="session-menu__item activity-feed__people-row"
    data-activity-person=${personId ?? ""}
    aria-pressed=${String(props.filters.personId === personId)}
    @click=${(event: Event) => selectPerson(event, props, personId)}
  >
    ${renderPersonAvatar(person, true)}
    <span class="activity-feed__people-copy">
      <span class="activity-feed__people-name"
        >${person ? compactPersonLabel(person) : t("activityFeed.everyone")}</span
      >
    </span>
    <span class="activity-feed__people-count">${count}</span>
  </button>`;
}

function renderPeopleControl(
  props: SessionActivityViewProps,
  people: readonly ActivityPerson[],
  selectedPerson: PresenceViewer | null,
  totalSessions: number,
) {
  const visible = people.slice(0, 3);
  const overflow = people.length - visible.length;
  const resolved = people.filter((person) => !isUnresolvedPerson(person));
  const unresolved = people.filter(isUnresolvedPerson);
  return html`<div class="activity-feed__people-control">
    <button
      id="activity-feed-people-trigger"
      type="button"
      class="btn btn--sm activity-feed__people-trigger"
      aria-label=${t("activityFeed.peopleButtonLabel")}
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      ${
        selectedPerson
          ? html`${renderPersonAvatar(selectedPerson)}<span class="activity-feed__selected-person"
                >${compactPersonLabel(selectedPerson)}</span
              >`
          : html`<span class="activity-feed__facepile" aria-hidden="true">
              ${
                visible.length > 0
                  ? visible.map((person) => renderPersonAvatar(person))
                  : html`<span
                      class="viewer-avatar viewer-avatar--overflow activity-feed__unknown-avatar"
                      >${icons.users}</span
                    >`
              }
              ${
                overflow > 0
                  ? html`<span class="viewer-avatar viewer-avatar--overflow">+${overflow}</span>`
                  : nothing
              }
            </span>`
      }
    </button>
    ${
      selectedPerson
        ? html`<button
            type="button"
            class="btn btn--sm activity-feed__people-clear"
            aria-label=${t("activityFeed.clearPersonFilter")}
            @click=${() => props.onFiltersChange({ ...props.filters, personId: null })}
          >
            ${icons.x}
          </button>`
        : nothing
    }
    <wa-popover
      ${ref(syncPopoverLabel)}
      class="activity-feed__people-popover"
      for="activity-feed-people-trigger"
      aria-label=${t("activityFeed.peopleButtonLabel")}
      placement="bottom-end"
      without-arrow
      @wa-show=${(event: Event) => setPeopleExpanded(event, true)}
      @wa-hide=${(event: Event) => setPeopleExpanded(event, false)}
    >
      <div class="activity-feed__people-panel">
        ${renderPersonRow(null, props, totalSessions)}
        ${resolved.map((person) => renderPersonRow(person, props))}
        ${
          unresolved.length > 0
            ? html`<div class="session-menu__separator" role="separator"></div>
                <div class="activity-feed__people-group-label">
                  ${t("activityFeed.unresolvedIdentities")}
                </div>
                <div data-activity-unresolved>
                  ${unresolved.map((person) => renderPersonRow(person, props))}
                </div>`
            : nothing
        }
        ${props.result?.peopleIncomplete ? html`<p class="activity-feed__footer" role="status">${t("activityFeed.partialHistory")}</p>` : nothing}
      </div>
    </wa-popover>
  </div>`;
}

function dayLabel(timestamp: number | null, now = Date.now()): string {
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

function renderSessionLink(
  context: ApplicationContext,
  row: GatewaySessionRow,
  onSummaryRetry?: (row: GatewaySessionRow) => void,
) {
  const agentId =
    parseAgentSessionKey(row.key)?.agentId ??
    row.agentId ??
    resolveSessionNavigationAgentId(context);
  const face = resolveSessionPreferredFace(row);
  const addressable = isSessionKeyAddressable(
    row.key,
    isUiGlobalScopeConfigured({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    }),
  );
  const target = addressable
    ? sessionNavigationTarget({
        face,
        sessionKey: row.key,
        fallbackAgentId: row.key === "global" ? agentId : resolveSessionNavigationAgentId(context),
        basePath: context.basePath,
        row,
        mainKey: resolveUiConfiguredMainKey({
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        }),
      })
    : null;
  const tag = target ? literal`a` : literal`div`;
  const owner = sessionActivityOwner(row);
  const ownerName = presenceViewerLabel(owner);
  const activityAt = sessionActivityTimestamp(row);
  const digestRunId = row.observerDigest?.runId;
  const activeObserverRunId =
    row.hasActiveRun === true && digestRunId && row.activeRunIds?.includes(digestRunId)
      ? digestRunId
      : undefined;
  const headline = activeObserverRunId ? row.observerDigest?.headline.trim() : "";
  const scope = row.channel ? t("activityFeed.channelLabel", { value: row.channel }) : null;
  const showAgent = row.kind !== "global" || Boolean(row.agentId);
  const source = row.createdVia === "cron" ? t("activityFeed.automation") : null;
  return staticHtml`<div
    class="activity-feed__session-row${target ? " activity-feed__session-row--link" : ""}"
  >
    <${tag}
      class="activity-feed__session"
      data-activity-session=${row.key}
      href=${target?.href ?? nothing}
      @click=${(event: MouseEvent) => {
        if (target && shouldHandleNavigationClick(event)) {
          event.preventDefault();
          context.navigate(face, target.options);
        }
      }}
    >
      <span class="activity-feed__session-avatar">
        ${
          row.hasActiveRun === true
            ? html`<span
                class="activity-feed__presence-dot activity-feed__run-dot"
                aria-hidden="true"
              ></span>`
            : nothing
        }
        <openclaw-viewer-avatar
          .identity=${row.owner?.actor.identity ?? row.createdActor?.identity}
          .user=${owner}
          .markAsViewer=${false}
          variant="footer"
        ></openclaw-viewer-avatar>
      </span>
      <span class="activity-feed__session-main">
        <span class="activity-feed__session-title">${resolveSessionDisplayName(row.key, row)}</span>
        <span class="activity-feed__session-meta">
          ${
            headline
              ? html`<span
                  class="activity-feed__session-headline"
                  data-health=${row.observerDigest?.health ?? nothing}
                  >${headline}</span
                >`
              : html`<span>${ownerName}</span>`
          }${
            source
              ? html`<span class="activity-feed__session-source" data-activity-created-via="cron"
                  >· ${source}${scope || showAgent ? " ·" : ""}</span
                >`
              : nothing
          }${
            showAgent
              ? html`<span class="activity-feed__session-scope"
                  >${renderAgentRowChip(agentId)}</span
                >`
              : nothing
          }${scope ? html`<span class="activity-feed__session-scope">${scope}</span>` : nothing}
        </span>
      </span>
      <span class="activity-feed__session-time">
        ${headline ? html`<span class="activity-feed__session-owner">${ownerName}</span>` : nothing}
        ${
          activityAt > 0
            ? html`<span>${formatRelativeTimestamp(activityAt, { fallback: "" })}</span>`
            : nothing
        }
      </span>
    </${tag}>
    ${renderSessionActivitySummary(row, onSummaryRetry)}
    <openclaw-activity-session-git
      .context=${context}
      .sessionKey=${scopedSessionArtifactKey(row.key, agentId)}
      .agentId=${agentId}
    ></openclaw-activity-session-git>
    <openclaw-activity-session-media
      .context=${context}
      .sessionKey=${scopedSessionArtifactKey(row.key, agentId)}
      .agentId=${agentId}
      .revision=${row.updatedAt ?? 0}
      .session=${row}
    ></openclaw-activity-session-media>
    ${
      activeObserverRunId
        ? html`<a
            class="activity-feed__inspect-run"
            href=${activityRunInspectorHref(activeObserverRunId, context.basePath)}
            >${t("activityFeed.inspectRun")}</a
          >`
        : nothing
    }
  </div>`;
}

function renderDaySessions(
  props: SessionActivityViewProps,
  day: ReturnType<typeof projectSessionActivity>["days"][number],
) {
  const renderRow = (row: GatewaySessionRow) =>
    renderSessionLink(props.context, row, props.onSummaryRetry);
  // GatewaySessionRow.hasAutomation records that an enabled cron job is bound to the session;
  // grouping must consume that fact directly rather than infer automation from titles or keys.
  const automation =
    props.filters.query || props.filters.personId
      ? []
      : day.sessions.filter((row) => row.hasAutomation === true);
  if (automation.length < 2) {
    return day.sessions.map(renderRow);
  }
  const expanded = props.expandedAutomationDays.has(day.key);
  return html`
    ${day.sessions.filter((row) => row.hasAutomation !== true).map(renderRow)}
    <button
      type="button"
      class="activity-feed__session activity-feed__automation-group"
      data-activity-automation-group=${day.key}
      aria-expanded=${String(expanded)}
      @click=${() => props.onAutomationDayToggle(day.key)}
    >
      <span class="activity-feed__automation-group-icon" aria-hidden="true">${icons.clock}</span>
      <span>${t("activityFeed.automationGroup", { count: String(automation.length) })}</span>
      <span class="activity-feed__automation-group-chevron" aria-hidden="true"
        >${icons.chevronRight}</span
      >
    </button>
    ${expanded ? automation.map(renderRow) : nothing}
  `;
}

function renderIdentityHeader(
  context: ApplicationContext,
  identity: PresenceViewer,
  rows: readonly GatewaySessionRow[],
) {
  const online = (identity.entries?.length ?? 0) > 0;
  const activity = presenceViewerActivity(identity);
  const status = online ? presenceActivityLabel(activity) : t("activityFeed.offline");
  const devices = identity.entries ?? [];
  const viewing = resolveViewingNow(identity, rows);
  return html`
    <section class="activity-feed__identity" data-activity-identity=${identity.id}>
      <div class="activity-feed__identity-main">
        <openclaw-viewer-avatar
          .identity=${{ type: "profile", id: identity.id }}
          .user=${identity}
          .markAsViewer=${false}
          variant="profile"
        ></openclaw-viewer-avatar>
        <div class="activity-feed__identity-copy">
          <h2>${presenceViewerLabel(identity)}</h2>
          ${identity.email ? html`<p>${identity.email}</p>` : nothing}
        </div>
        ${renderSettingsStatus({ kind: online && activity !== "unknown" ? (activity === "idle" ? "warn" : "ok") : "muted", label: status })}
      </div>
      ${
        devices.length > 0
          ? html`<div class="activity-feed__devices">
              ${devices.map((entry) => {
                const device = [entry.deviceFamily, entry.platform, entry.ip, entry.timeZone]
                  .filter(Boolean)
                  .join(" · ");
                return html`<div class="activity-feed__device">
                  <span class="activity-feed__device-name"
                    >${entry.host ?? t("activityFeed.unknownDevice")}</span
                  >
                  ${device ? html`<span>${device}</span>` : nothing}
                  ${
                    entry.ip
                      ? html`<openclaw-ip-location .ip=${entry.ip}></openclaw-ip-location>`
                      : nothing
                  }
                  ${
                    entry.lastInputSeconds !== undefined
                      ? html`<span
                          >${t("activityFeed.lastInput", {
                            time: formatTimeAgo(entry.lastInputSeconds * 1000, { suffix: false }),
                          })}</span
                        >`
                      : nothing
                  }
                </div>`;
              })}
            </div>`
          : nothing
      }
      <div class="activity-feed__viewing">
        <h3>${t("activityFeed.viewingNow")}</h3>
        ${
          viewing.length > 0
            ? html`<div class="activity-feed__viewing-list">
                ${viewing.map((row) => renderSessionLink(context, row))}
              </div>`
            : html`<p class="activity-feed__empty-note">${t("activityFeed.notViewing")}</p>`
        }
      </div>
    </section>
  `;
}

function renderActivityLoading() {
  return html`<section class="activity-feed__loading" aria-busy="true">
    <span class="sr-only" role="status">${t("common.loading")}</span>
    <div class="skeleton activity-pulse activity-pulse--loading" aria-hidden="true"></div>
    <div class="activity-feed__sessions" aria-hidden="true">
      ${Array.from(
        { length: 4 },
        () => html`
          <div class="activity-feed__session-row">
            <div class="activity-feed__session">
              <span class="skeleton activity-feed__loading-avatar"></span>
              <div class="activity-feed__session-main">
                <div class="skeleton skeleton-line skeleton-line--medium"></div>
                <div class="skeleton skeleton-line activity-feed__loading-meta"></div>
              </div>
            </div>
            <div class="activity-feed__recap activity-feed__recap-skeleton">
              <div class="skeleton skeleton-line skeleton-line--long"></div>
              <div class="skeleton skeleton-line skeleton-line--medium"></div>
            </div>
          </div>
        `,
      )}
    </div>
  </section>`;
}

export function renderSessionActivityView(props: SessionActivityViewProps) {
  const projection = projectSessionActivity(props.result);
  const onlineById = new Map(
    props.presenceViewers.flatMap((person) =>
      person.identity ? [[person.identity.id, person] as const] : [],
    ),
  );
  const identity = props.filters.personId
    ? (onlineById.get(props.filters.personId) ??
      projection.people.find((person) => person.id === props.filters.personId) ??
      null)
    : null;
  const people = projection.people.map((person) => {
    const online = onlineById.get(person.id);
    return online ? { ...person, ...online, count: person.count } : person;
  });
  const selectedPerson = props.filters.personId
    ? (people.find((person) => person.id === props.filters.personId) ?? identity)
    : null;
  return html`
    <div class="activity-feed">
      <div class="activity-feed__toolbar">
        <label class="data-table-search activity-feed__search">
          ${icons.search}
          <input
            type="search"
            aria-label=${t("activityFeed.searchPlaceholder")}
            .value=${props.filters.query}
            placeholder=${t("activityFeed.searchPlaceholder")}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                props.onFiltersChange({ ...props.filters, query: event.currentTarget.value });
              }
            }}
          />
        </label>
        ${renderSettingsSegmented({
          mode: "buttons",
          className: "activity-feed__time-filter",
          value: props.filters.time,
          ariaLabel: t("activityFeed.time"),
          options: ACTIVITY_TIME_FILTERS.map((time) => ({
            value: time,
            label: t(TIME_LABELS[time]),
            ariaLabel: t(TIME_LABELS[time]),
            compactLabel: time === "all" ? t(TIME_LABELS[time]) : time,
          })),
          onChange: (time) => props.onFiltersChange({ ...props.filters, time }),
          onReselect: (time) => props.onFiltersChange({ ...props.filters, time }),
        })}
        ${renderPeopleControl(props, people, selectedPerson, projection.timeCount)}
      </div>
      <div class="activity-feed__feedback">
        <span role=${props.error ? "alert" : "status"} title=${props.error ?? nothing}>
          ${props.error ?? (props.retrying ? t("common.refreshing") : nothing)}
        </span>
        ${
          props.error || props.retrying
            ? html`<button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRetry}>
                ${t("common.retry")}
              </button>`
            : nothing
        }
      </div>
      <div class="activity-feed__main">
        ${props.loading && !props.result ? renderActivityLoading() : nothing}
        ${
          props.result?.activityPulse
            ? renderSessionActivityPulse(props.result.activityPulse, props.filters.time, {
                peopleIncomplete: props.result.peopleIncomplete,
              })
            : nothing
        }
        ${
          props.result && props.filters.personId
            ? identity
              ? renderIdentityHeader(props.context, identity, projection.sessions)
              : html`<section class="activity-feed__not-found" role="status">
                  <h2>${t("activityFeed.notFoundTitle")}</h2>
                  <p>${t("activityFeed.notFoundDescription")}</p>
                </section>`
            : nothing
        }
        ${
          props.result && (!props.filters.personId || identity)
            ? html`
                ${
                  projection.days.length > 0
                    ? projection.days.map(
                        (day) => html`<section class="activity-feed__day">
                          <h3>${dayLabel(day.timestamp)}</h3>
                          <div class="activity-feed__sessions">
                            ${renderDaySessions(props, day)}
                          </div>
                        </section>`,
                      )
                    : html`<section class="activity-feed__empty" role="status">
                        ${t("activityFeed.noSessions")}
                      </section>`
                }
                ${projection.matchedCount > projection.sessions.length ? html`<p class="activity-feed__footer">${t("activityFeed.showing", { shown: String(projection.sessions.length), total: String(projection.matchedCount) })}</p>` : nothing}
              `
            : nothing
        }
      </div>
    </div>
  `;
}
