import { createMemo, Show, untrack } from "solid-js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { sessionParticipantIdentityKey } from "../lib/chat/sender-label.ts";
import { getLocale, t } from "../lib/reactive/i18n.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import "./sidebar-collapse-toggle.tsx";
import { renderSessionOwnerAvatar } from "./session-owner-chip.ts";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";

type SessionFilterHost = Pick<SessionListHost, "sessionsStatusFilter">;

/** The Sessions title owns the sidebar owner choice. */
function SidebarOwnerPicker(props: { host: SessionListHost }) {
  const owners = createMemo(() => {
    // The row projection resolves the owner facet before its visibility is read.
    const options = props.host.sessionOwnerOptions;
    return props.host.sessionOwnershipVisibility.filters ? options : [];
  });
  const ownerId = () => props.host.sessionOwnerFilterId;
  const selfId = () =>
    props.host.sidebarSnapshot?.footer?.id ??
    (props.host.sessionDataContext
      ? gatewayPresentationScope(props.host.sessionDataContext.gateway).displayUser?.id
      : undefined);
  const label = () =>
    props.host.sessionInvolvingMeFilterActive
      ? t("sessionsView.involvingMe")
      : ownerId() && ownerId() === selfId()
        ? t("chat.sidebar.mySessions")
        : ownerId()
          ? (owners().find((entry) => entry.id === ownerId())?.label ?? ownerId()!)
          : t("sessionsView.allOwners");
  const optionKeys = createMemo(
    () => [
      ownerId(),
      selfId(),
      props.host.sessionInvolvingMeFilterActive,
      Boolean(props.host.sidebarSnapshot),
      isMobileNavLayout(),
      getLocale(),
      ...owners().flatMap((entry) => [
        entry.id,
        entry.label,
        entry.avatarUrl,
        entry.identity ? sessionParticipantIdentityKey(entry.identity) : null,
      ]),
    ],
    {
      equals: (previous, next) =>
        previous.length === next.length && previous.every((value, index) => value === next[index]),
    },
  );
  const options = () => [
    { value: "all", label: t("sessionsView.allOwners") },
    { value: "involving-me", label: t("sessionsView.involvingMe") },
    ...owners().map((entry) => ({
      value: `owner:${entry.id}`,
      label: entry.id === selfId() ? t("chat.sidebar.mySessions") : (entry.label ?? entry.id),
    })),
    ...(ownerId() && !owners().some((entry) => entry.id === ownerId())
      ? [{ value: `owner:${ownerId()}`, label: label() }]
      : []),
  ];
  const params = createMemo(() => {
    optionKeys();
    return untrack(() => ({
      id: "sidebar-session-owner-title",
      class: "sidebar-session-owner-filter",
      label: t("sessionsView.owners"),
      value: props.host.sessionInvolvingMeFilterActive
        ? "involving-me"
        : ownerId()
          ? `owner:${ownerId()}`
          : "all",
      disabled: Boolean(props.host.sidebarSnapshot),
      searchable: "always" as const,
      sheet: isMobileNavLayout(),
      showOptionTooltips: false,
      renderLeading: (option: { value: string }) => {
        const owner = owners().find((entry) => `owner:${entry.id}` === option.value);
        return owner ? renderSessionOwnerAvatar(owner) : undefined;
      },
      options: options(),
      onChange: (value: string) =>
        props.host.setSessionOwnerFilter(
          value.startsWith("owner:") ? value.slice("owner:".length) : null,
          value === "involving-me",
        ),
    }));
  });
  return (
    <Show
      when={owners().length > 0 || ownerId() !== null || props.host.sessionInvolvingMeFilterActive}
      fallback={
        <span class="sidebar-recent-sessions__label-text">{t("chat.sidebar.threads")}</span>
      }
    >
      <Picker {...params()} />
    </Show>
  );
}

/** Only the panel's Status choice contributes to its filter indicator. */
export function countSidebarSessionFilters(host: SessionFilterHost) {
  return Number(host.sessionsStatusFilter !== "active");
}

function renderSidebarSessionFilter(
  host: SessionFilterHost & Pick<SessionListHost, "sidebarMenus">,
  className: string,
) {
  const count = createMemo(() => countSidebarSessionFilters(host));
  return (
    <button
      type="button"
      class={[className, "sidebar-session-sort", { "sidebar-session-sort--filtered": count() > 0 }]}
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
export function renderSessionListToolbar(host: SessionListHost & { onToggleSidebar?: () => void }) {
  return (
    <div class="sidebar-session-toolbar sidebar-panel-header" onMouseDown={beginNativeWindowDrag}>
      <SidebarOwnerPicker host={host} />
      {renderSidebarSessionFilter(host, "sidebar-session-toolbar__button")}
      <openclaw-sidebar-collapse-toggle prop:onToggle={() => host.onToggleSidebar?.()} />
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
