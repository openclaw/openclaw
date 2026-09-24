import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  SIDEBAR_SESSION_STATUS_OPTIONS,
  type SidebarEmptyGroupsMode,
  type SidebarSessionGroupMenuState,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
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

function renderSidebarMenuTrigger(position: { x: number; y: number }, label: string) {
  return html`
    <button
      slot="trigger"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      aria-label=${label}
      style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
    ></button>
  `;
}

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
        <wa-dropdown-item
          class="session-menu__item"
          value="group-defaults"
          ?disabled=${
            !params.connected || Boolean(params.actionDisabledReasons?.["group-defaults"])
          }
          title=${params.actionDisabledReasons?.["group-defaults"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.settings}</span>
          <span class="session-menu__text"
            >${
              params.groupDefaultsUnavailable
                ? `${t("common.retry")}: ${t("sessionsView.groupDefaultsMenu")}`
                : t("sessionsView.groupDefaultsMenu")
            }</span
          >
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="rename-group"
          ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.["rename-group"])}
          title=${params.actionDisabledReasons?.["rename-group"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
          <span class="session-menu__text">${t("sessionsView.renameGroupMenu")}</span>
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="new-group"
          ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.["new-group"])}
          title=${params.actionDisabledReasons?.["new-group"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
          <span class="session-menu__text">${t("sessionsView.newGroup")}</span>
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item
          class="session-menu__item session-menu__item--destructive"
          value="delete-group"
          variant="danger"
          ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.["delete-group"])}
          title=${params.actionDisabledReasons?.["delete-group"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="session-menu__text">${t("sessionsView.deleteGroupMenu")}</span>
        </wa-dropdown-item>
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
  activeFilterCount: number;
  onResetFilters: () => void;
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
  const ownerVisible =
    params.owners.length > 0 || params.ownerFilterId !== null || params.involvingMe;
  const ownerValue = params.involvingMe
    ? "involving-me"
    : params.ownerFilterId !== null
      ? `owner:${params.ownerFilterId}`
      : "all";
  const segmented = <T extends string>(
    id: string,
    label: string,
    value: T,
    options: ReadonlyArray<{ value: T; label: string }>,
    onChange: (value: T) => void,
    visibleLabel = label,
  ) => html`<div id=${id} class="sidebar-session-menu-row">
    <span aria-hidden="true" title=${label}>${visibleLabel}</span>
    ${renderSettingsSegmented({
      value,
      options: options.map((option) => ({ ...option, title: option.label })),
      ariaLabel: label,
      className: "sidebar-session-menu-segmented",
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
    params.position,
    html`<openclaw-sidebar-session-filter-popover
      class="sidebar-session-sort-menu"
      .anchor=${params.trigger}
      .label=${t("chat.sidebar.sortSessions")}
      .onClose=${params.onClose}
      .content=${html`
        <section
          class="sidebar-session-menu-section"
          aria-labelledby="sidebar-sessions-filters-label"
        >
          <div class="sidebar-session-menu-heading">
            <h3 id="sidebar-sessions-filters-label">${t("chat.sidebar.menuFilters")}</h3>
            ${
              params.activeFilterCount > 0
                ? html`<button
                    type="button"
                    id="sidebar-sessions-reset"
                    class="sidebar-session-menu-reset"
                    @click=${(event: Event) => {
                      (event.currentTarget as HTMLElement)
                        .closest(".sidebar-session-filter-panel")
                        ?.querySelector<HTMLElement>(
                          '#sidebar-sessions-status wa-radio[value="active"]',
                        )
                        ?.focus();
                      params.onResetFilters();
                    }}
                  >
                    ${t("common.reset")}
                  </button>`
                : nothing
            }
          </div>
          ${segmented(
            "sidebar-sessions-status",
            t("sessionsView.status"),
            params.statusFilter,
            SIDEBAR_SESSION_STATUS_OPTIONS.map((value) => ({
              value,
              label:
                value === "active"
                  ? t("common.active")
                  : value === "archived"
                    ? t("sessionsView.archived")
                    : t("sessionsView.all"),
            })),
            params.onStatusFilterChange,
          )}
          ${
            ownerVisible
              ? html`<div class="sidebar-session-menu-row">
                  <label for="sidebar-sessions-owner">${t("sessionsView.owners")}</label>
                  ${renderPicker({
                    id: "sidebar-sessions-owner",
                    label: t("sessionsView.owners"),
                    value: ownerValue,
                    searchable: true,
                    showOptionTooltips: false,
                    renderLeading: (option) => {
                      const owner = params.owners.find(
                        (entry) => `owner:${entry.id}` === option.value,
                      );
                      return owner ? renderSessionOwnerAvatar(owner) : nothing;
                    },
                    options: [
                      { value: "all", label: t("sessionsView.allOwners") },
                      { value: "involving-me", label: t("sessionsView.involvingMe") },
                      ...params.owners.map((owner) => ({
                        value: `owner:${owner.id}`,
                        label:
                          owner.id === params.selfOwnerId
                            ? t("sessionsView.ownerYou", { name: owner.label ?? owner.id })
                            : (owner.label ?? owner.id),
                      })),
                      ...(params.ownerFilterId !== null &&
                      !params.owners.some((owner) => owner.id === params.ownerFilterId)
                        ? [{ value: `owner:${params.ownerFilterId}`, label: params.ownerFilterId }]
                        : []),
                    ],
                    onChange: (value) =>
                      params.onOwnerFilterChange(
                        value.startsWith("owner:") ? value.slice("owner:".length) : null,
                        value === "involving-me",
                      ),
                  })}
                </div>`
              : nothing
          }
          ${switchItem("sidebar-sessions-cron", t("sessionsView.showCronSessions"), params.showCron, params.onShowCronChange)}
          ${switchItem("sidebar-sessions-system", t("sessionsView.showSystemSessions"), params.showSystem, params.onShowSystemChange)}
        </section>
        <section
          class="sidebar-session-menu-section"
          aria-labelledby="sidebar-sessions-display-label"
        >
          <div class="sidebar-session-menu-heading">
            <h3 id="sidebar-sessions-display-label">${t("chat.sidebar.menuDisplay")}</h3>
          </div>
          ${
            params.rosterMode
              ? nothing
              : renderPicker({
                  id: "sidebar-sessions-group",
                  label: t("sessionsView.groupBy"),
                  value: params.grouping,
                  variant: "submenu",
                  showOptionTooltips: false,
                  options: [
                    { value: "category", label: t("sessionsView.groupByCategory") },
                    { value: "project", label: t("chat.sidebar.catalogGroupByProject") },
                    ...(params.peopleSortAvailable
                      ? [{ value: "person", label: t("sessionsView.groupByPerson") }]
                      : []),
                    { value: "none", label: t("sessionsView.groupByNone") },
                  ],
                  onChange: (value) => params.onGroupingChange(value as SidebarSessionsGrouping),
                })
          }
          ${renderPicker({
            id: "sidebar-sessions-sort",
            label: t("chat.sidebar.sortBy"),
            value: params.sortMode,
            variant: "submenu",
            showOptionTooltips: false,
            options: SIDEBAR_SESSION_SORT_OPTIONS.filter(
              (option) => option.mode !== "people" || params.peopleSortAvailable,
            ).map((option) => ({ value: option.mode, label: t(option.labelKey) })),
            onChange: (value) => {
              const option = SIDEBAR_SESSION_SORT_OPTIONS.find((entry) => entry.mode === value);
              if (option) {
                params.onSortModeChange(option.mode);
              }
            },
          })}
          ${
            params.rosterMode
              ? nothing
              : renderPicker({
                  id: "sidebar-sessions-empty",
                  label: t("sessionsView.hideEmptyGroups"),
                  value: params.emptyGroupsMode,
                  variant: "submenu",
                  showOptionTooltips: false,
                  options: EMPTY_GROUPS_OPTIONS.map((option) => ({
                    value: option.mode,
                    label: t(option.labelKey),
                  })),
                  onChange: (value) => {
                    const option = EMPTY_GROUPS_OPTIONS.find((entry) => entry.mode === value);
                    if (option) {
                      params.onEmptyGroupsModeChange(option.mode);
                    }
                  },
                })
          }
          ${switchItem("sidebar-sessions-preview", t("sessionsView.showSessionPreview"), params.showPreview, params.onShowPreviewChange)}
        </section>
        <footer class="sidebar-session-menu-footer">
          <a
            id="sidebar-sessions-sources"
            class="sidebar-session-filter-footer"
            href=${params.sessionSourcesHref}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                params.onOpenSessionSources();
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
