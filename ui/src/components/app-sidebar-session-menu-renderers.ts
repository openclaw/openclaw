import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { renderSidebarMenuTrigger } from "./app-sidebar-nav-menus.ts";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  SIDEBAR_SESSION_STATUS_OPTIONS,
  type SidebarEmptyGroupsMode,
  type SidebarSessionGroupMenuState,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  renderCompactSessionMenuFrame,
  renderCompactSessionMenuNavigationItem,
} from "./session-menu-compact.ts";
import {
  renderSessionOwnerAvatar,
  renderSessionOwnerChip,
  type SessionOwnerOption,
} from "./session-owner-chip.ts";
import type { SidebarFilterMenuView } from "./sidebar-menus-controller.ts";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

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

function renderSidebarMenuCheckbox(value: string, checked: boolean, label: string) {
  return html`<wa-dropdown-item
    class="sidebar-session-sort-menu__item"
    type="checkbox"
    value=${value}
    .checked=${checked}
  >
    <span class="session-menu__text">${label}</span>
    <span slot="details" class="session-menu__check" aria-hidden="true"
      >${checked ? icons.check : nothing}</span
    >
  </wa-dropdown-item>`;
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

function renderSidebarEmptyGroupsOptions(mode: SidebarEmptyGroupsMode, submenu: boolean) {
  return EMPTY_GROUPS_OPTIONS.map((option) =>
    renderSidebarMenuRadioItem({
      value: `empty-groups:${option.mode}`,
      checked: mode === option.mode,
      label: t(option.labelKey),
      submenu,
    }),
  );
}

function renderSidebarEmptyGroupsMenu(mode: SidebarEmptyGroupsMode, compact: boolean) {
  const selected = EMPTY_GROUPS_OPTIONS.find((option) => option.mode === mode)!;
  const label = t("sessionsView.hideEmptyGroups");
  const modeLabel = t(selected.labelKey);
  const accessibleLabel = t("sessionsView.hideEmptyGroupsSelected", { mode: modeLabel });
  const details = html`<span class="sidebar-session-empty-groups-value">${modeLabel}</span>`;
  return compact
    ? renderCompactSessionMenuNavigationItem({
        value: "compact:open-empty-groups",
        label,
        icon: icons.listFilter,
        details,
        accessibleLabel,
      })
    : html`<wa-dropdown-item
        class="sidebar-session-sort-menu__item sidebar-session-empty-groups-submenu sidebar-session-choice-submenu"
        aria-label=${accessibleLabel}
      >
        <span class="session-menu__text">${label}</span>
        <span slot="details">${details}</span>
        ${renderSidebarEmptyGroupsOptions(mode, true)}
      </wa-dropdown-item>`;
}

function renderCompactSidebarOwnerFilter(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  selfOwnerId: string | null;
}) {
  return renderCompactSessionMenuFrame(
    html`${renderSidebarOwnerOptions({ ...params, submenu: false })}`,
  );
}

function sidebarFilterMenuViewForValue(value: string | undefined): SidebarFilterMenuView | null {
  if (value === "compact:open-specific-owner") {
    return "specific-owner";
  }
  if (value === "compact:open-empty-groups") {
    return "empty-groups";
  }
  return value === "compact:back" ? "root" : null;
}

export function renderSidebarSessionGroupMenu(params: {
  menu: SidebarSessionGroupMenuState;
  trigger: HTMLElement | null;
  connected: boolean;
  groupDefaultsUnavailable?: boolean;
  actionDisabledReasons?: Partial<Record<SidebarSessionGroupMenuAction, string>>;
  onAction: (action: SidebarSessionGroupMenuAction, group: string) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const menu = params.menu;
  const renderAction = (
    action: SidebarSessionGroupMenuAction,
    label: string,
    icon: TemplateResult,
  ) => html`<wa-dropdown-item
    class=${`session-menu__item${action === "delete-group" ? " session-menu__item--destructive" : ""}`}
    value=${action}
    variant=${action === "delete-group" ? "danger" : nothing}
    ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.[action])}
    title=${params.actionDisabledReasons?.[action] ?? nothing}
  >
    <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
    <span class="session-menu__text">${label}</span>
  </wa-dropdown-item>`;
  return keyed(
    menu,
    html`
      <wa-dropdown
        class="session-menu sidebar-session-group-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          if (
            (value === "group-defaults" ||
              value === "rename-group" ||
              value === "new-group" ||
              value === "delete-group") &&
            !params.actionDisabledReasons?.[value]
          ) {
            params.onAction(value, menu.group);
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        ${renderSidebarMenuTrigger(menu, t("sessionsView.groupMenu", { group: menu.group }))}
        ${renderAction(
          "group-defaults",
          params.groupDefaultsUnavailable
            ? `${t("common.retry")}: ${t("sessionsView.groupDefaultsMenu")}`
            : t("sessionsView.groupDefaultsMenu"),
          icons.settings,
        )}
        ${renderAction("rename-group", t("sessionsView.renameGroupMenu"), icons.edit)}
        ${renderAction("new-group", t("sessionsView.newGroup"), icons.folder)}
        <div class="session-menu__separator" role="separator"></div>
        ${renderAction("delete-group", t("sessionsView.deleteGroupMenu"), icons.trash)}
      </wa-dropdown>
    `,
  );
}

export function renderSidebarCatalogViewMenu(params: {
  position: { catalogId: string; x: number; y: number };
  trigger: HTMLElement | null;
  grouping: CatalogProjectGrouping;
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  compact: boolean;
  view: SidebarFilterMenuView;
  onViewChange: (view: SidebarFilterMenuView) => void;
  onGroupingChange: (grouping: CatalogProjectGrouping) => void;
  onOwnerFilterChange: (ownerId: string | null, involvingMe?: boolean) => void;
  onHide: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const position = params.position;
  const groupingOptions = [
    { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
    { grouping: "person", label: t("chat.sidebar.catalogGroupByPerson") },
    { grouping: "none", label: t("sessionsView.groupByNone") },
  ] as const satisfies ReadonlyArray<{ grouping: CatalogProjectGrouping; label: string }>;
  return keyed(
    `${position.catalogId}:${position.x}:${position.y}`,
    html`
      <wa-dropdown
        class=${`sidebar-session-sort-menu sidebar-catalog-view-menu${params.compact ? " session-menu--compact" : ""}`}
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("chat.sidebar.catalogViewOptions")}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          const view = sidebarFilterMenuViewForValue(value);
          if (view) {
            params.onViewChange(view);
          } else if (value?.startsWith("grouping:")) {
            params.onGroupingChange(value.slice("grouping:".length) as CatalogProjectGrouping);
          } else if (value?.startsWith("owner:")) {
            params.onOwnerFilterChange(value.slice("owner:".length) || null);
          } else if (value === "involving-me") {
            params.onOwnerFilterChange(null, true);
          } else if (value === "hide-catalog") {
            params.onHide();
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        ${renderSidebarMenuTrigger(position, t("chat.sidebar.catalogViewOptions"))}
        ${
          params.compact && params.view === "specific-owner"
            ? renderCompactSidebarOwnerFilter(params)
            : html`<div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
                ${groupingOptions.map((option) =>
                  renderSidebarMenuRadioItem({
                    value: `grouping:${option.grouping}`,
                    checked: params.grouping === option.grouping,
                    label: option.label,
                  }),
                )}
                ${renderSidebarOwnerFilter(params)}
                <div class="session-menu__separator" role="separator"></div>
                <wa-dropdown-item class="sidebar-session-sort-menu__item" value="hide-catalog">
                  <span class="session-menu__text">${t("chat.sidebar.hideFromSidebar")}</span>
                </wa-dropdown-item>`
        }
      </wa-dropdown>
    `,
  );
}

export function renderSidebarSessionSortMenu(params: {
  position: { x: number; y: number };
  trigger: HTMLElement | null;
  sessionSourcesHref: string;
  grouping: SidebarSessionsGrouping;
  rosterMode: boolean;
  sortMode: SidebarSessionSortMode;
  peopleSortAvailable: boolean;
  statusFilter: SidebarSessionStatusFilter;
  showCron: boolean;
  showPreview: boolean;
  showSystem: boolean;
  emptyGroupsMode: SidebarEmptyGroupsMode;
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  compact: boolean;
  view: SidebarFilterMenuView;
  onViewChange: (view: SidebarFilterMenuView) => void;
  onGroupingChange: (grouping: SidebarSessionsGrouping) => void;
  onSortModeChange: (mode: SidebarSessionSortMode) => void;
  onStatusFilterChange: (statusFilter: SidebarSessionStatusFilter) => void;
  onOwnerFilterChange: (ownerId: string | null, involvingMe?: boolean) => void;
  onShowCronChange: (show: boolean) => void;
  onShowPreviewChange: (show: boolean) => void;
  onShowSystemChange: (show: boolean) => void;
  onEmptyGroupsModeChange: (mode: SidebarEmptyGroupsMode) => void;
  onOpenSessionSources: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const position = params.position;
  const groupingOptions = [
    { grouping: "category", label: t("sessionsView.groupByCategory") },
    { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
    { grouping: "person", label: t("sessionsView.groupByPerson") },
    { grouping: "none", label: t("sessionsView.groupByNone") },
  ] as const satisfies ReadonlyArray<{ grouping: SidebarSessionsGrouping; label: string }>;
  return keyed(
    `${position.x}:${position.y}`,
    html`
      <wa-dropdown
        class=${`sidebar-session-sort-menu${params.rosterMode || params.compact ? "" : " sidebar-session-sort-menu--preferences"}${params.compact ? " session-menu--compact" : ""}`}
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("chat.sidebar.sortSessions")}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          const view = sidebarFilterMenuViewForValue(value);
          if (view) {
            params.onViewChange(view);
          } else if (value === "session-sources") {
            params.onOpenSessionSources();
          } else if (value?.startsWith("grouping:")) {
            params.onGroupingChange(value.slice("grouping:".length) as SidebarSessionsGrouping);
          } else if (value?.startsWith("sort:")) {
            params.onSortModeChange(value.slice("sort:".length) as SidebarSessionSortMode);
          } else if (value?.startsWith("status:")) {
            params.onStatusFilterChange(
              value.slice("status:".length) as SidebarSessionStatusFilter,
            );
          } else if (value?.startsWith("owner:")) {
            params.onOwnerFilterChange(value.slice("owner:".length) || null);
          } else if (value === "involving-me") {
            params.onOwnerFilterChange(null, true);
          } else if (value === "show-preview") {
            params.onShowPreviewChange(!params.showPreview);
          } else if (value === "show-cron") {
            params.onShowCronChange(!params.showCron);
          } else if (value === "show-system") {
            params.onShowSystemChange(!params.showSystem);
          } else {
            const option = EMPTY_GROUPS_OPTIONS.find(
              (candidate) => value === `empty-groups:${candidate.mode}`,
            );
            if (option) {
              params.onEmptyGroupsModeChange(option.mode);
            }
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        ${renderSidebarMenuTrigger(position, t("chat.sidebar.sortSessions"))}
        ${
          params.compact && params.view !== "root"
            ? params.view === "specific-owner"
              ? renderCompactSidebarOwnerFilter(params)
              : renderCompactSessionMenuFrame(
                  renderSidebarEmptyGroupsOptions(params.emptyGroupsMode, false),
                )
            : html`<wa-dropdown-item
                  class="sidebar-session-sort-menu__item"
                  value="session-sources"
                  @click=${(event: MouseEvent) => {
                    if (shouldHandleNavigationClick(event)) {
                      event.preventDefault();
                    } else {
                      event.stopPropagation();
                    }
                  }}
                >
                  <a href=${params.sessionSourcesHref} tabindex="-1">
                    <span class="session-menu__icon" aria-hidden="true">${icons.settings}</span>
                    <span class="session-menu__text">${t("chat.sidebar.sessionSources")}</span>
                  </a>
                </wa-dropdown-item>
                <div class="session-menu__separator" role="separator"></div>
                ${
                  params.rosterMode
                    ? nothing
                    : html`<div class="sidebar-session-sort-menu__title">
                          ${t("sessionsView.groupBy")}
                        </div>
                        ${groupingOptions
                          .filter(
                            (option) => option.grouping !== "person" || params.peopleSortAvailable,
                          )
                          .map((option) =>
                            renderSidebarMenuRadioItem({
                              value: `grouping:${option.grouping}`,
                              checked: params.grouping === option.grouping,
                              label: option.label,
                            }),
                          )}
                        <div class="session-menu__separator" role="separator"></div> `
                }
                <div class="sidebar-session-sort-menu__title">${t("chat.sidebar.sortBy")}</div>
                ${SIDEBAR_SESSION_SORT_OPTIONS.filter(
                  (option) => option.mode !== "people" || params.peopleSortAvailable,
                ).map((option) =>
                  renderSidebarMenuRadioItem({
                    value: `sort:${option.mode}`,
                    checked: params.sortMode === option.mode,
                    label: t(option.labelKey),
                  }),
                )}
                <div class="session-menu__separator" role="separator"></div>
                <div class="sidebar-session-sort-menu__title">${t("sessionsView.status")}</div>
                ${SIDEBAR_SESSION_STATUS_OPTIONS.map((statusFilter) =>
                  renderSidebarMenuRadioItem({
                    value: `status:${statusFilter}`,
                    checked: params.statusFilter === statusFilter,
                    label:
                      statusFilter === "active"
                        ? t("common.active")
                        : statusFilter === "archived"
                          ? t("sessionsView.archived")
                          : t("sessionsView.all"),
                  }),
                )}
                ${renderSidebarOwnerFilter(params)}
                <div class="session-menu__separator" role="separator"></div>
                ${renderSidebarMenuCheckbox(
                  "show-preview",
                  params.showPreview,
                  t("sessionsView.showSessionPreview"),
                )}
                ${renderSidebarMenuCheckbox("show-cron", params.showCron, t("sessionsView.showCronSessions"))}
                ${renderSidebarMenuCheckbox("show-system", params.showSystem, t("sessionsView.showSystemSessions"))}
                ${
                  params.rosterMode
                    ? nothing
                    : renderSidebarEmptyGroupsMenu(params.emptyGroupsMode, params.compact)
                }`
        }
      </wa-dropdown>
    `,
  );
}
