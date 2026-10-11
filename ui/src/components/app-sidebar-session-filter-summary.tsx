import { createMemo, For, Show } from "solid-js";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { sessionSelfOwner } from "./session-owner-chip.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
import { renderSessionOwnerAvatar } from "./solid/session-presentation.tsx";

/**
 * Quiet toolbar summary of the active sidebar filters. The whole control clears
 * them; its lead glyph (owner avatar, or an archive mark for status-only
 * filters) turns into the clear icon on hover so the row spends no width on a
 * second affordance.
 */
function renderSessionFilterSummary(host: SessionListHost) {
  const ownerId = createMemo(() =>
    host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null,
  );
  const owner = createMemo(() => {
    const ownerIdValue = ownerId();
    return ownerIdValue
      ? host.sessionOwnerOptions.find((option) => option.id === ownerIdValue)
      : host.sessionInvolvingMeFilterActive
        ? sessionSelfOwner(
            resolveCurrentSelfUser({
              snapshotUser: host.sessionDataContext?.gateway.snapshot.selfUser,
              presenceEntries: readPresenceEntries(host.sessionData.presencePayload),
              presenceInstanceId: host.sessionData.presenceInstanceId,
            }),
          )
        : undefined;
  });
  const parts = createMemo(() => {
    const ownerIdValue = ownerId();
    const ownerValue = owner();
    return [
      ...(ownerIdValue ? [ownerValue?.label ?? ownerIdValue] : []),
      ...(host.sessionInvolvingMeFilterActive ? [t("sessionsView.involvingMe")] : []),
      ...(host.sessionsStatusFilter === "active"
        ? []
        : [t(`sessionsView.${host.sessionsStatusFilter}`)]),
    ];
  });
  const summaryText = createMemo(() => parts().join(" · "));
  const showAll = createMemo(() => t("chat.sidebar.showAllSessions"));
  return (
    <button
      type="button"
      class="sidebar-session-filter-summary"
      title={showAll()}
      aria-label={`${summaryText()} · ${showAll()}`}
      onClick={() => {
        host.setSessionOwnerFilter(null);
        if (host.sessionsStatusFilter !== "active") {
          host.sessionOrganizer.setSessionsStatusFilter("active");
        }
      }}
    >
      <span class="sidebar-session-filter-summary__lead" aria-hidden="true">
        <span class="sidebar-session-filter-summary__glyph">
          <Show when={owner()} fallback={<Icon name="archive" />}>
            {(value) => renderSessionOwnerAvatar(value())}
          </Show>
        </span>
        <span class="sidebar-session-filter-summary__clear">
          <Icon name="x" />
        </span>
      </span>
      <span class="sidebar-session-filter-summary__label">
        <For each={parts()} keyed={false}>
          {(part, index) => (
            <>
              {index > 0 ? (
                <span class="sidebar-session-filter-summary__sep" aria-hidden="true">
                  ·
                </span>
              ) : undefined}
              {part()}
            </>
          )}
        </For>
      </span>
    </button>
  );
}
type SessionFilterHost = Pick<
  SessionListHost,
  "sessionOwnerFilterActive" | "sessionInvolvingMeFilterActive" | "sessionsStatusFilter"
>;

/** Only Owners and Status filter sessions; the other panel rows are display choices. */
export function countSidebarSessionFilters(host: SessionFilterHost) {
  return (
    Number(host.sessionOwnerFilterActive || host.sessionInvolvingMeFilterActive) +
    Number(host.sessionsStatusFilter !== "active")
  );
}
export function renderSidebarSessionFilter(
  host: SessionFilterHost & Pick<SessionListHost, "sidebarMenus">,
  className: string,
) {
  const count = createMemo(() => countSidebarSessionFilters(host));
  return (
    <button
      type="button"
      class={`${className} sidebar-session-sort ${count() > 0 ? "sidebar-session-sort--filtered" : ""}`}
      title={t("chat.sidebar.sortSessions")}
      aria-label={t("chat.sidebar.sortSessions")}
      aria-description={
        count() > 0
          ? t("chat.sidebar.activeFilterCount", {
              count: String(count()),
            })
          : undefined
      }
      aria-haspopup="dialog"
      aria-expanded={host.sidebarMenus.sessionSortMenuPosition !== null ? "true" : "false"}
      onClick={(event: MouseEvent) => {
        if (event.currentTarget instanceof HTMLElement) {
          host.sidebarMenus.togglePositionedMenu("sessionSort", event.currentTarget);
        }
      }}
    >
      <Icon name="listFilter" />
    </button>
  );
}
export function renderSessionListToolbar(host: SessionListHost) {
  const newSessionAccess = createMemo(() => host.readNewSessionAccess());
  return (
    <div class="sidebar-session-toolbar">
      <span class="sidebar-recent-sessions__label-text">{t("chat.sidebar.threads")}</span>
      {countSidebarSessionFilters(host) > 0 ? renderSessionFilterSummary(host) : undefined}
      {renderSidebarSessionFilter(host, "sidebar-session-toolbar__button")}
      {renderNewSessionLink({
        get basePath() {
          return host.basePath;
        },
        get agentId() {
          return host.expandedAgentId();
        },
        get className() {
          return "sidebar-session-toolbar__button sidebar-new-session";
        },
        get label() {
          return t("agentChip.newConversation");
        },
        get showShortcut() {
          return true;
        },
        get disabledReason() {
          return (() => {
            const access = newSessionAccess();
            return access.allowed ? undefined : access.reason;
          })();
        },
        onOpen: (agentId, target) => host.requestOpenNewSession(agentId, target),
      })}
    </div>
  );
}
export function renderSessionMutationError(host: Pick<SessionListHost, "sessionData">) {
  return host.sessionData.sessionMutationError ? (
    <div
      class="sidebar-session-error callout danger callout--dismissible"
      role="alert"
      data-sidebar-session-error=""
    >
      <span class="callout__content">{host.sessionData.sessionMutationError}</span>
      <openclaw-tooltip prop:content={t("chat.actions.dismissError")}>
        <button
          class="callout__dismiss"
          type="button"
          onClick={() => host.sessionData.dismissSessionMutationError()}
          aria-label={t("chat.actions.dismissError")}
        >
          <Icon name="x" />
        </button>
      </openclaw-tooltip>
    </div>
  ) : undefined;
}

/** Each list supplies settlement from its own request owner, not its sibling's cache. */
export function renderPersonalSessionEmpty(
  host: Pick<
    SessionListHost,
    "sessionsStatusFilter" | "sessionOwnerFilterActive" | "sessionInvolvingMeFilterActive"
  >,
  empty: boolean,
  settled: boolean,
) {
  return empty &&
    settled &&
    host.sessionsStatusFilter === "active" &&
    (host.sessionOwnerFilterActive || host.sessionInvolvingMeFilterActive) ? (
    <span class="sidebar-session-empty-hint">{t("chat.sidebar.noActiveSessionsForFilter")}</span>
  ) : undefined;
}
