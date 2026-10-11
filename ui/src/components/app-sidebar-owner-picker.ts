import { html, nothing } from "lit";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../i18n/index.ts";
import type { SessionListHost } from "./app-sidebar-session-row-render.ts";
import { renderPicker } from "./select-picker.ts";
import { renderSessionOwnerAvatar } from "./session-owner-chip.ts";

/** The Sessions title owns the sidebar owner choice. */
export function renderSidebarOwnerPicker(
  host: Pick<
    SessionListHost,
    | "sidebarSnapshot"
    | "sessionOwnershipVisibility"
    | "sessionOwnerOptions"
    | "sessionOwnerFilterId"
    | "sessionDataContext"
    | "sessionInvolvingMeFilterActive"
    | "setSessionOwnerFilter"
  >,
) {
  const owners = host.sessionOwnershipVisibility.filters ? host.sessionOwnerOptions : [];
  const ownerId = host.sessionOwnerFilterId;
  if (owners.length === 0 && ownerId === null && !host.sessionInvolvingMeFilterActive) {
    return html`<span class="sidebar-recent-sessions__label-text"
      >${t("chat.sidebar.threads")}</span
    >`;
  }
  const selfId =
    host.sidebarSnapshot?.footer?.id ??
    (host.sessionDataContext
      ? gatewayPresentationScope(host.sessionDataContext.gateway).displayUser?.id
      : undefined);
  const owner = owners.find((entry) => entry.id === ownerId);
  const label = host.sessionInvolvingMeFilterActive
    ? t("sessionsView.involvingMe")
    : ownerId && ownerId === selfId
      ? t("chat.sidebar.mySessions")
      : ownerId
        ? (owner?.label ?? ownerId)
        : t("sessionsView.allOwners");
  return renderPicker({
    id: "sidebar-session-owner-title",
    className: "sidebar-session-owner-filter",
    label: t("sessionsView.owners"),
    value: host.sessionInvolvingMeFilterActive
      ? "involving-me"
      : ownerId
        ? `owner:${ownerId}`
        : "all",
    disabled: Boolean(host.sidebarSnapshot),
    searchable: "always",
    sheet: isMobileNavLayout(),
    showOptionTooltips: false,
    renderLeading: (option) => {
      const optionOwner = owners.find((entry) => `owner:${entry.id}` === option.value);
      return optionOwner ? renderSessionOwnerAvatar(optionOwner) : nothing;
    },
    options: [
      { value: "all", label: t("sessionsView.allOwners") },
      { value: "involving-me", label: t("sessionsView.involvingMe") },
      ...owners.map((entry) => ({
        value: `owner:${entry.id}`,
        label: entry.id === selfId ? t("chat.sidebar.mySessions") : (entry.label ?? entry.id),
      })),
      ...(ownerId && !owners.some((entry) => entry.id === ownerId)
        ? [{ value: `owner:${ownerId}`, label }]
        : []),
    ],
    onChange: (value) =>
      host.setSessionOwnerFilter(
        value.startsWith("owner:") ? value.slice("owner:".length) : null,
        value === "involving-me",
      ),
  });
}
