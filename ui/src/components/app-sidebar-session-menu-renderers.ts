import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { pathForRoute } from "../app-route-paths.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import { renderSidebarDropdown } from "./app-sidebar-nav-menus.ts";
import { countSidebarSessionFilters } from "./app-sidebar-session-filter-summary.ts";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  SIDEBAR_SESSION_STATUS_OPTIONS,
} from "./app-sidebar-session-types.ts";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import { icons } from "./icons.ts";
import { renderPicker } from "./select-picker.ts";
import {
  renderCompactSessionMenuFrame,
  renderCompactSessionMenuNavigationItem,
} from "./session-menu-compact.ts";
import "./sidebar-session-filter-popover.ts";
import {
  renderSessionOwnerAvatar,
  renderSessionOwnerChip,
  type SessionOwnerOption,
} from "./session-owner-chip.ts";
import { renderSettingsSegmented } from "./settings-ui.ts";
import type { SidebarFilterMenuView, SidebarMenusController } from "./sidebar-menus-controller.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SidebarSessionGroupMenuAction =
  | "group-defaults"
  | "rename-group"
  | "new-group"
  | "delete-group";

function renderSidebarMenuRadioItem(params: {
  value: string;
  checked: boolean;
  label: string;
  owner?: SessionOwnerOption;
  submenu?: boolean;
}) {
  return html`
    <wa-dropdown-item
      slot=${params.submenu ? "submenu" : nothing}
      class="sidebar-session-sort-menu__item"
      value=${params.value}
      role="menuitemradio"
      aria-label=${params.label}
      aria-checked=${String(params.checked)}
      ${ref((element) => syncDropdownItemRadio(element, params.checked))}
    >
      <span slot="details" class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
      <span class="row session-menu__label">
        ${params.owner ? renderSessionOwnerChip(params.owner, "row", "owned") : nothing}
        <span class="session-menu__text">${params.label}</span>
      </span>
    </wa-dropdown-item>
  `;
}

function renderSidebarOwnerOptions(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  selfOwnerId: string | null;
  submenu: boolean;
}) {
  return params.owners.map((owner) =>
    renderSidebarMenuRadioItem({
      value: `owner:${owner.id}`,
      checked: params.ownerFilterId === owner.id,
      label:
        owner.id === params.selfOwnerId
          ? t("sessionsView.ownerYou", { name: owner.label ?? owner.id })
          : (owner.label ?? owner.id),
      owner,
      submenu: params.submenu,
    }),
  );
}

function renderSidebarOwnerFilter(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  compact: boolean;
}) {
  const { owners, ownerFilterId, involvingMe } = params;
  if (owners.length === 0 && ownerFilterId === null && !involvingMe) {
    return nothing;
  }
  const selectedOwner = owners.find((owner) => owner.id === ownerFilterId);
  const selectedName = selectedOwner?.label ?? selectedOwner?.id;
  const accessibleLabel = selectedName
    ? t("sessionsView.specificOwnerSelected", { name: selectedName })
    : t("sessionsView.specificOwnerAvailable", { count: String(owners.length) });
  const details = selectedOwner
    ? html`${renderSessionOwnerAvatar(selectedOwner)}
        <span class="sidebar-session-owner-selection__name">${selectedName}</span>`
    : html`<span class="sidebar-session-owner-count">${owners.length}</span>`;
  return html`
    <div class="session-menu__separator" role="separator"></div>
    <div class="sidebar-session-sort-menu__title">${t("sessionsView.owners")}</div>
    ${renderSidebarMenuRadioItem({
      value: "owner:",
      checked: ownerFilterId === null && !involvingMe,
      label: t("sessionsView.allOwners"),
    })}
    ${renderSidebarMenuRadioItem({
      value: "involving-me",
      checked: involvingMe,
      label: t("sessionsView.involvingMe"),
    })}
    ${
      owners.length > 0
        ? params.compact
          ? renderCompactSessionMenuNavigationItem({
              value: "compact:open-specific-owner",
              label: t("sessionsView.specificOwner"),
              icon: icons.users,
              details: html`<span class="session-menu__shortcut sidebar-session-owner-selection"
                >${details}</span
              >`,
              accessibleLabel,
            })
          : html`<wa-dropdown-item
              class="sidebar-session-sort-menu__item sidebar-session-owner-submenu sidebar-session-choice-submenu"
              aria-label=${accessibleLabel}
            >
              <span class="session-menu__text">${t("sessionsView.specificOwner")}</span>
              <span
                slot="details"
                class="session-menu__shortcut sidebar-session-owner-selection"
                aria-hidden="true"
                >${details}</span
              >
              ${renderSidebarOwnerOptions({ ...params, submenu: true })}
            </wa-dropdown-item>`
        : nothing
    }
  `;
}

const EMPTY_GROUPS_OPTIONS = [
  { mode: "filtering", labelKey: "sessionsView.emptyGroupsWhenFiltering" },
  { mode: "always", labelKey: "sessionsView.emptyGroupsAlways" },
  { mode: "never", labelKey: "sessionsView.emptyGroupsNever" },
] as const;

function sidebarFilterMenuViewForValue(value: string | undefined): SidebarFilterMenuView | null {
  if (value === "compact:open-specific-owner") {
    return "specific-owner";
  }
  return value === "compact:back" ? "root" : null;
}

export function renderSidebarSessionGroupMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const menu = controller.sessionGroupMenu;
  if (!menu) {
    return nothing;
  }
  const trigger = controller.sessionGroupMenuTrigger;
  const groupDefaultsStatus = host.sessionDataContext?.sessions.groupsStatus() ?? "idle";
  const groupActionMethods = {
    "group-defaults": "sessions.groups.update",
    "rename-group": "sessions.groups.rename",
    "new-group": "sessions.groups.put",
    "delete-group": "sessions.groups.delete",
  } as const;
  const actionDisabledReasons = Object.fromEntries(
    Object.entries(groupActionMethods).flatMap(([action, method]) => {
      const access = readSessionMethodAccess(host.sessionDataContext?.gateway.snapshot, {
        method,
        requiredScope: "operator.write",
      });
      if (!access.allowed) {
        return [[action, access.reason]];
      }
      return action === "group-defaults" &&
        groupDefaultsStatus !== "ready" &&
        groupDefaultsStatus !== "unavailable"
        ? [[action, t("common.loading")]]
        : [];
    }),
  );
  const renderAction = (
    action: SidebarSessionGroupMenuAction,
    label: string,
    icon: TemplateResult,
  ) => html`<wa-dropdown-item
    class=${`session-menu__item${action === "delete-group" ? " session-menu__item--destructive" : ""}`}
    value=${action}
    variant=${action === "delete-group" ? "danger" : nothing}
    ?disabled=${!host.connected || Boolean(actionDisabledReasons[action])}
    title=${actionDisabledReasons[action] ?? nothing}
  >
    <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
    <span class="session-menu__text">${label}</span>
  </wa-dropdown-item>`;
  return keyed(
    menu,
    renderSidebarDropdown({
      position: menu,
      className: "session-menu sidebar-session-group-menu",
      label: t("sessionsView.groupMenu", { group: menu.group }),
      onSelect: ({ value }) => {
        if (
          (value === "group-defaults" ||
            value === "rename-group" ||
            value === "new-group" ||
            value === "delete-group") &&
          !actionDisabledReasons[value]
        ) {
          controller.closeSessionGroupMenu({ restoreFocus: true });
          switch (value) {
            case "group-defaults":
              if (groupDefaultsStatus === "unavailable") {
                host.sessionDataContext?.sessions.groupsInvalidate();
                void host.sessionDataContext?.sessions.groupsLoad();
                break;
              }
              void host.sessionOrganizer.editSessionGroupDefaults(menu.group);
              break;
            case "rename-group":
              void host.sessionOrganizer.renameSessionGroupFromMenu(menu.group);
              break;
            case "new-group":
              void host.sessionOrganizer.createSessionGroup();
              break;
            case "delete-group":
              void host.sessionOrganizer.deleteSessionGroupFromMenu(menu.group);
              break;
          }
        }
      },
      onTabAway: () => trigger?.focus(),
      onClose: (restoreFocus) => {
        if (controller.sessionGroupMenu === menu) {
          controller.closeSessionGroupMenu({ restoreFocus });
        }
      },
      content: html`
        ${renderAction(
          "group-defaults",
          groupDefaultsStatus === "unavailable"
            ? `${t("common.retry")}: ${t("sessionsView.groupDefaultsMenu")}`
            : t("sessionsView.groupDefaultsMenu"),
          icons.settings,
        )}
        ${renderAction("rename-group", t("sessionsView.renameGroupMenu"), icons.edit)}
        ${renderAction("new-group", t("sessionsView.newGroup"), icons.folder)}
        <div class="session-menu__separator" role="separator"></div>
        ${renderAction("delete-group", t("sessionsView.deleteGroupMenu"), icons.trash)}
      `,
    }),
  );
}

export function renderSidebarCatalogViewMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.catalogViewMenuPosition;
  if (!position) {
    return nothing;
  }
  const ownerFilter = {
    owners: host.sessionOwnershipVisibility.filters ? host.sessionOwnerOptions : [],
    ownerFilterId: host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null,
    involvingMe: host.sessionInvolvingMeFilterActive,
    selfOwnerId: host.sessionDataContext?.gateway.snapshot.selfUser?.id ?? null,
    compact: isMobileNavLayout(),
  };
  const setOwnerFilter = (ownerId: string | null, involvingMe = false) => {
    host.setSessionOwnerFilter(ownerId, involvingMe);
    controller.closePositionedMenu("catalogView", { restoreFocus: true });
  };
  const groupingOptions = [
    { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
    { grouping: "person", label: t("chat.sidebar.catalogGroupByPerson") },
    { grouping: "none", label: t("sessionsView.groupByNone") },
  ] as const satisfies ReadonlyArray<{ grouping: CatalogProjectGrouping; label: string }>;
  return keyed(
    `${position.catalogId}:${position.x}:${position.y}`,
    renderSidebarDropdown({
      position,
      className: `sidebar-session-sort-menu sidebar-catalog-view-menu${ownerFilter.compact ? " session-menu--compact" : ""}`,
      label: t("chat.sidebar.catalogViewOptions"),
      onSelect: ({ value }) => {
        const view = sidebarFilterMenuViewForValue(value);
        if (view) {
          controller.setFilterMenuView(view);
        } else if (value?.startsWith("grouping:")) {
          host.setCatalogProjectGrouping(value.slice("grouping:".length) as CatalogProjectGrouping);
          controller.closePositionedMenu("catalogView", { restoreFocus: true });
        } else if (value?.startsWith("owner:")) {
          setOwnerFilter(value.slice("owner:".length) || null);
        } else if (value === "involving-me") {
          setOwnerFilter(null, true);
        } else if (value === "hide-catalog" && controller.catalogViewMenuPosition === position) {
          host.hideSessionCatalog(position.catalogId);
          controller.closePositionedMenu("catalogView");
        }
      },
      ...controller.positionedMenuHandlers("catalogView"),
      content: html`
        ${
          ownerFilter.compact && controller.filterMenuView === "specific-owner"
            ? renderCompactSessionMenuFrame(
                html`${renderSidebarOwnerOptions({ ...ownerFilter, submenu: false })}`,
              )
            : html`<div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
                ${groupingOptions.map((option) =>
                  renderSidebarMenuRadioItem({
                    value: `grouping:${option.grouping}`,
                    checked: host.catalogProjectGrouping === option.grouping,
                    label: option.label,
                  }),
                )}
                ${renderSidebarOwnerFilter(ownerFilter)}
                <div class="session-menu__separator" role="separator"></div>
                <wa-dropdown-item class="sidebar-session-sort-menu__item" value="hide-catalog">
                  <span class="session-menu__text">${t("chat.sidebar.hideFromSidebar")}</span>
                </wa-dropdown-item>`
        }
      `,
    }),
  );
}

export function renderSidebarSessionSortMenuForController(controller: SidebarMenusController) {
  const { host } = controller;
  const position = controller.sessionSortMenuPosition;
  if (!position) {
    return nothing;
  }
  const sessionSources = SETTINGS_ROUTE_TARGETS.sessionSources;
  const rosterMode = host.sidebarAgentsMode === "roster";
  const grouping = host.effectiveSessionsGrouping();
  const owners = host.sessionOwnershipVisibility.filters ? host.sessionOwnerOptions : [];
  const ownerFilterId = host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null;
  const involvingMe = host.sessionInvolvingMeFilterActive;
  const selfOwnerId = host.sessionDataContext?.gateway.snapshot.selfUser?.id ?? null;
  const peopleSortAvailable = host.sessionPeopleSortAvailable();
  // Reset covers the panel; the toolbar dot still counts only Owners and Status.
  const settingsChanged =
    countSidebarSessionFilters(host) > 0 ||
    host.sessionsShowCron ||
    host.sessionsShowSystem ||
    host.sessionsShowPreview ||
    host.effectiveSessionSortMode() !== "created" ||
    (!rosterMode && (grouping !== "category" || host.sessionsEmptyGroupsMode !== "filtering"));
  const ownerVisible = owners.length > 0 || ownerFilterId !== null || involvingMe;
  // The mobile sheet has no hover or room for flyouts: choices open as sheet pages.
  const sheet = isMobileNavLayout();
  const ownerValue = involvingMe
    ? "involving-me"
    : ownerFilterId !== null
      ? `owner:${ownerFilterId}`
      : "all";
  const segmented = <T extends string>(
    id: string,
    label: string,
    value: T,
    options: ReadonlyArray<{ value: T; label: string }>,
    onChange: (value: T) => void,
  ) => html`<div id=${id} class="sidebar-session-menu-row">
    <span aria-hidden="true" title=${label}>${label}</span>
    ${renderSettingsSegmented({
      value,
      options: options.map((option) => ({ ...option, title: option.label })),
      ariaLabel: label,
      class: "sidebar-session-menu-segmented",
      onChange,
    })}
  </div>`;
  const switchItem = (
    id: string,
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ) => html`<button
    type="button"
    role="switch"
    id=${id}
    aria-checked=${String(checked)}
    class="sidebar-session-menu-switch"
    @click=${() => onChange(!checked)}
  >
    <span>${label}</span
    ><span inert aria-hidden="true">
      <wa-switch size="s" .checked=${checked} tabindex="-1"></wa-switch>
    </span>
  </button>`;
  return keyed(
    position,
    html`<openclaw-sidebar-session-filter-popover
      class="sidebar-session-sort-menu"
      .anchor=${controller.sessionSortMenuTrigger}
      .label=${t("chat.sidebar.sortSessions")}
      .onClose=${controller.positionedMenuHandlers("sessionSort").onClose}
      .content=${html`
        <section
          class="sidebar-session-menu-section"
          aria-labelledby="sidebar-sessions-filters-label"
        >
          <div class="sidebar-session-menu-heading">
            <h3 id="sidebar-sessions-filters-label">${t("chat.sidebar.menuFilters")}</h3>
            ${
              settingsChanged
                ? html`<button
                    type="button"
                    id="sidebar-sessions-reset"
                    class="sidebar-session-menu-reset"
                    @click=${(event: Event) => {
                      (event.currentTarget as HTMLElement)
                        .closest(".sidebar-session-filter-panel")
                        ?.querySelector<HTMLElement>(
                          '#sidebar-sessions-status input[type="radio"][value="active"]',
                        )
                        ?.focus();
                      host.setSessionOwnerFilter(null);
                      host.sessionOrganizer.setSessionsStatusFilter("active");
                      host.sessionOrganizer.setSessionsShowCron(false);
                      host.sessionOrganizer.setSessionsShowSystem(false);
                      host.sessionOrganizer.setSessionsShowPreview(false);
                      host.setSessionSortMode("created");
                      if (!rosterMode) {
                        // A displayed default can hide a saved Person choice until owners return.
                        if (grouping !== "category") {
                          host.sessionOrganizer.setSessionsGrouping("category");
                        }
                        host.setSessionsEmptyGroupsMode("filtering");
                      }
                    }}
                  >
                    ${t("common.reset")}
                  </button>`
                : nothing
            }
          </div>
          ${
            ownerVisible
              ? html`<div class="sidebar-session-menu-row">
                  <label for="sidebar-sessions-owner">${t("sessionsView.owners")}</label>
                  ${renderPicker({
                    id: "sidebar-sessions-owner",
                    label: t("sessionsView.owners"),
                    value: ownerValue,
                    searchable: "always",
                    sheet,
                    showOptionTooltips: false,
                    renderLeading: (option) => {
                      const owner = owners.find((entry) => `owner:${entry.id}` === option.value);
                      return owner ? renderSessionOwnerAvatar(owner) : nothing;
                    },
                    options: [
                      { value: "all", label: t("sessionsView.allOwners") },
                      { value: "involving-me", label: t("sessionsView.involvingMe") },
                      ...owners.map((owner) => ({
                        value: `owner:${owner.id}`,
                        label:
                          owner.id === selfOwnerId
                            ? t("sessionsView.ownerYou", { name: owner.label ?? owner.id })
                            : (owner.label ?? owner.id),
                      })),
                      ...(ownerFilterId !== null &&
                      !owners.some((owner) => owner.id === ownerFilterId)
                        ? [{ value: `owner:${ownerFilterId}`, label: ownerFilterId }]
                        : []),
                    ],
                    onChange: (value) =>
                      host.setSessionOwnerFilter(
                        value.startsWith("owner:") ? value.slice("owner:".length) : null,
                        value === "involving-me",
                      ),
                  })}
                </div>`
              : nothing
          }
          ${segmented(
            "sidebar-sessions-status",
            t("sessionsView.status"),
            host.sessionsStatusFilter,
            SIDEBAR_SESSION_STATUS_OPTIONS.map((value) => ({
              value,
              label: value === "active" ? t("common.active") : t(`sessionsView.${value}`),
            })),
            (statusFilter) => host.sessionOrganizer.setSessionsStatusFilter(statusFilter),
          )}
          ${switchItem("sidebar-sessions-cron", t("sessionsView.showCronSessions"), host.sessionsShowCron, (show) => host.sessionOrganizer.setSessionsShowCron(show))}
          ${switchItem("sidebar-sessions-system", t("sessionsView.showSystemSessions"), host.sessionsShowSystem, (show) => host.sessionOrganizer.setSessionsShowSystem(show))}
        </section>
        <section
          class="sidebar-session-menu-section"
          aria-labelledby="sidebar-sessions-display-label"
        >
          <div class="sidebar-session-menu-heading">
            <h3 id="sidebar-sessions-display-label">${t("chat.sidebar.menuDisplay")}</h3>
          </div>
          ${
            rosterMode
              ? nothing
              : renderPicker({
                  id: "sidebar-sessions-group",
                  label: t("sessionsView.groupBy"),
                  value: grouping,
                  variant: "submenu",
                  sheet,
                  showOptionTooltips: false,
                  options: [
                    { value: "category", label: t("sessionsView.groupByCategory") },
                    { value: "project", label: t("chat.sidebar.catalogGroupByProject") },
                    ...(peopleSortAvailable
                      ? [{ value: "person", label: t("sessionsView.groupByPerson") }]
                      : []),
                    { value: "none", label: t("sessionsView.groupByNone") },
                  ],
                  onChange: (value) =>
                    host.sessionOrganizer.setSessionsGrouping(value as SidebarSessionsGrouping),
                })
          }
          ${renderPicker({
            id: "sidebar-sessions-sort",
            label: t("chat.sidebar.sortBy"),
            value: host.effectiveSessionSortMode(),
            variant: "submenu",
            sheet,
            showOptionTooltips: false,
            options: SIDEBAR_SESSION_SORT_OPTIONS.filter(
              (option) => option.mode !== "people" || peopleSortAvailable,
            ).map((option) => ({ value: option.mode, label: t(option.labelKey) })),
            onChange: (value) => {
              const option = SIDEBAR_SESSION_SORT_OPTIONS.find((entry) => entry.mode === value);
              if (option) {
                host.setSessionSortMode(option.mode);
              }
            },
          })}
          ${
            rosterMode
              ? nothing
              : renderPicker({
                  id: "sidebar-sessions-empty",
                  label: t("sessionsView.hideEmptyGroups"),
                  value: host.sessionsEmptyGroupsMode,
                  variant: "submenu",
                  sheet,
                  showOptionTooltips: false,
                  options: EMPTY_GROUPS_OPTIONS.map((option) => ({
                    value: option.mode,
                    label: t(option.labelKey),
                  })),
                  onChange: (value) => {
                    const option = EMPTY_GROUPS_OPTIONS.find((entry) => entry.mode === value);
                    if (option && controller.sessionSortMenuPosition === position) {
                      host.setSessionsEmptyGroupsMode(option.mode);
                    }
                  },
                })
          }
          ${switchItem("sidebar-sessions-preview", t("sessionsView.showSessionPreview"), host.sessionsShowPreview, (show) => host.sessionOrganizer.setSessionsShowPreview(show))}
        </section>
        <footer class="sidebar-session-menu-footer">
          <a
            id="sidebar-sessions-sources"
            class="sidebar-session-filter-footer"
            href=${pathForRoute(sessionSources.routeId, host.basePath) + sessionSources.search + sessionSources.hash}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                controller.closePositionedMenu("sessionSort");
                host.onNavigate?.(sessionSources.routeId, {
                  search: sessionSources.search,
                  hash: sessionSources.hash,
                });
              }
            }}
          >
            <span aria-hidden="true">${icons.settings}</span>${t("chat.sidebar.sessionSources")}
          </a>
        </footer>
      `}
    ></openclaw-sidebar-session-filter-popover>`,
  );
}
