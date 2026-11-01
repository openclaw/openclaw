import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { registerSessionMenuEnglish } from "../i18n/locales/en-session-menu.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import { SidebarDropdown } from "./app-sidebar-dropdown.tsx";
import { countSidebarSessionFilters } from "./app-sidebar-session-filter-summary.tsx";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  SIDEBAR_SESSION_STATUS_OPTIONS,
} from "./app-sidebar-session-types.ts";
import { createPersonalSessionGroupActions } from "./personal-session-group-actions.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import {
  createSessionGroup,
  renameSessionGroupFromMenu,
  deleteSessionGroupFromMenu,
  editSessionGroupDefaults,
  setSessionsGrouping,
  setSessionsShowCron,
  setSessionsShowPreview,
  setSessionsShowSystem,
  setSessionsStatusFilter,
} from "./session-organizer-menu.runtime.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarFilterMenuView, SidebarMenus } from "./sidebar-menus.tsx";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Icon } from "./solid/icon.tsx";
import type { MenuEntry, MenuItem } from "./solid/menu.tsx";
import { Picker } from "./solid/select-picker.tsx";
import { SettingsSegmented, SettingsToggle } from "./solid/settings-ui.tsx";
import {
  SidebarMenuRadioItem,
  SidebarOwnerFilter,
  SidebarOwnerOptions,
} from "./solid/sidebar-owner-filter.tsx";

registerSessionMenuEnglish();

type SidebarSessionGroupMenuAction =
  | "group-defaults"
  | "rename-group"
  | "new-group"
  | "delete-group";

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

export function renderSidebarSessionGroupMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  menu: NonNullable<SidebarMenus["sessionGroupMenu"]>,
): JSX.Element {
  const trigger = menus.triggers.get("sessionGroup");
  const groupDefaultsStatus = () => host.sessionDataContext?.sessions.groupsStatus() ?? "idle";
  const groupActionMethods = {
    "group-defaults": "sessions.groups.update",
    "rename-group": "sessions.groups.rename",
    "new-group": "sessions.groups.put",
    "delete-group": "sessions.groups.delete",
  } as const;
  const actionDisabledReasons = createMemo(() =>
    Object.fromEntries(
      Object.entries(groupActionMethods).flatMap(([action, method]) => {
        const access = readSessionMethodAccess(host.sessionDataContext?.gateway.snapshot, {
          method,
          requiredScope: "operator.write",
        });
        if (!access.allowed) {
          return [[action, access.reason]];
        }
        return action === "group-defaults" &&
          groupDefaultsStatus() !== "ready" &&
          groupDefaultsStatus() !== "unavailable"
          ? [[action, t("common.loading")]]
          : [];
      }),
    ),
  );
  const renderAction = (
    action: SidebarSessionGroupMenuAction,
    label: string,
    icon: JSX.Element,
  ): MenuItem => ({
    id: action,
    label,
    icon,
    class: `session-menu__item${action === "delete-group" ? " session-menu__item--destructive" : ""}`,
    variant: action === "delete-group" ? "danger" : undefined,
    disabled: !host.connected || Boolean(actionDisabledReasons()[action]),
    attributes: { title: actionDisabledReasons()[action] },
    content: <span class="session-menu__text">{label}</span>,
  });
  const items = createMemo<MenuEntry[]>(() => [
    renderAction(
      "group-defaults",
      groupDefaultsStatus() === "unavailable"
        ? `${t("common.retry")}: ${t("sessionsView.groupDefaultsMenu")}`
        : t("sessionsView.groupDefaultsMenu"),
      <Icon name="settings" />,
    ),
    renderAction("rename-group", t("sessionsView.renameGroupMenu"), <Icon name="edit" />),
    renderAction("new-group", t("sessionsView.newGroup"), <Icon name="folder" />),
    {
      kind: "content",
      id: "separator",
      content: <div class="session-menu__separator" role="separator" />,
    },
    renderAction("delete-group", t("sessionsView.deleteGroupMenu"), <Icon name="trash" />),
  ]);
  return (
    <SidebarDropdown
      position={menu}
      class="session-menu sidebar-session-group-menu"
      label={t("sessionsView.groupMenu", { group: menu.group })}
      onSelect={(value) => {
        if (
          (value === "group-defaults" ||
            value === "rename-group" ||
            value === "new-group" ||
            value === "delete-group") &&
          !actionDisabledReasons()[value]
        ) {
          menus.closeSessionGroupMenu({ restoreFocus: true });
          switch (value) {
            case "group-defaults":
              if (groupDefaultsStatus() === "unavailable") {
                host.sessionDataContext?.sessions.groupsInvalidate();
                void host.sessionDataContext?.sessions.groupsLoad();
                break;
              }
              void editSessionGroupDefaults(host.sessionOrganizer, menu.group);
              break;
            case "rename-group":
              void renameSessionGroupFromMenu(host.sessionOrganizer, menu.group);
              break;
            case "new-group":
              void createSessionGroup(host.sessionOrganizer);
              break;
            case "delete-group":
              void deleteSessionGroupFromMenu(host.sessionOrganizer, menu.group);
              break;
          }
        }
      }}
      anchor={trigger ?? undefined}
      onClose={(restoreFocus) => {
        if (menus.sessionGroupMenu === menu) {
          menus.closeSessionGroupMenu({ restoreFocus });
        }
      }}
      items={items()}
    />
  );
}

export function renderSidebarCatalogViewMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["catalogViewMenuPosition"]>,
): JSX.Element {
  const menuRef = menus.menuRef("catalogView");
  const ownerFilter = createMemo(() => ({
    owners: host.sessionOwnershipVisibility.filters ? host.sessionOwnerOptions : [],
    ownerFilterId: host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null,
    involvingMe: host.sessionInvolvingMeFilterActive,
    selfOwnerId: host.sessionDataContext?.gateway.snapshot.selfUser?.id ?? null,
    compact: isMobileNavLayout(),
  }));
  const setOwnerFilter = (ownerId: string | null, involvingMe = false) => {
    host.setSessionOwnerFilter(ownerId, involvingMe);
    menus.closePositionedMenu("catalogView", { restoreFocus: true });
  };
  const groupingOptions = createMemo(
    () =>
      [
        { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
        { grouping: "person", label: t("chat.sidebar.catalogGroupByPerson") },
        { grouping: "none", label: t("sessionsView.groupByNone") },
      ] as const satisfies ReadonlyArray<{ grouping: CatalogProjectGrouping; label: string }>,
  );
  const items = createMemo<MenuEntry[]>(() =>
    ownerFilter().compact && menus.filterMenuView === "specific-owner"
      ? [
          {
            id: "compact:back",
            label: t("common.back"),
            class: "session-menu__item session-menu__back",
            icon: <Icon name="arrowLeft" />,
            closeOnSelect: false,
          },
          ...SidebarOwnerOptions(ownerFilter()),
        ]
      : [
          {
            kind: "content",
            id: "group-heading",
            content: (
              <div class="sidebar-session-sort-menu__title">{t("sessionsView.groupBy")}</div>
            ),
          },
          ...groupingOptions().map((option) =>
            SidebarMenuRadioItem({
              value: `grouping:${option.grouping}`,
              checked: host.catalogProjectGrouping === option.grouping,
              label: option.label,
            }),
          ),
          ...SidebarOwnerFilter(ownerFilter()),
          {
            kind: "content",
            id: "separator",
            content: <div class="session-menu__separator" role="separator" />,
          },
          {
            id: "hide-catalog",
            label: t("chat.sidebar.hideFromSidebar"),
            class: "sidebar-session-sort-menu__item",
          },
        ],
  );
  return (
    <SidebarDropdown
      ref={menuRef}
      position={position}
      class={[
        "sidebar-session-sort-menu sidebar-catalog-view-menu",
        ownerFilter().compact && "session-menu--compact",
      ]}
      label={t("chat.sidebar.catalogViewOptions")}
      onSelect={(value) => {
        const view = sidebarFilterMenuViewForValue(value);
        if (view) {
          menus.setFilterMenuView(view);
        } else if (value?.startsWith("grouping:")) {
          host.setCatalogProjectGrouping(
            // SAFETY: This owned menu emits grouping values only from groupingOptions below.
            value.slice("grouping:".length) as CatalogProjectGrouping,
          );
          menus.closePositionedMenu("catalogView", { restoreFocus: true });
        } else if (value?.startsWith("owner:")) {
          setOwnerFilter(value.slice("owner:".length) || null);
        } else if (value === "involving-me") {
          setOwnerFilter(null, true);
        } else if (value === "hide-catalog" && menus.catalogViewMenuPosition === position) {
          host.hideSessionCatalog(position.catalogId);
          menus.closePositionedMenu("catalogView");
        }
      }}
      {...menus.positionedMenuHandlers("catalogView")}
      items={items()}
    />
  );
}

export function renderSidebarSessionSortMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["sessionSortMenuPosition"]>,
): JSX.Element {
  let defaultStatus: HTMLInputElement | undefined;
  const statusInputs = new Map<string, HTMLInputElement>();
  const controls = new Map<string, HTMLElement>();
  const pickers = new Map<string, PickerFocusHandle>();
  const sessionSources = SETTINGS_ROUTE_TARGETS.sessionSources;
  const rosterMode = () => host.sidebarAgentsMode === "roster";
  const grouping = () => host.effectiveSessionsGrouping();
  const peopleSortAvailable = () => host.sessionPeopleSortAvailable();
  // Reset covers the panel; the toolbar dot counts only Status.
  const settingsChanged = createMemo(
    () =>
      countSidebarSessionFilters(host) > 0 ||
      host.sessionsShowCron ||
      host.sessionsShowSystem ||
      host.sessionsShowPreview ||
      host.effectiveSessionSortMode() !== "created" ||
      (!rosterMode() &&
        (grouping() !== "category" || host.sessionsEmptyGroupsMode !== "filtering")),
  );
  // The mobile sheet has no hover or room for flyouts: choices open as sheet pages.
  const sheet = () => isMobileNavLayout();
  const switchItem = (
    id: string,
    label: () => string,
    checked: () => boolean,
    onChange: (checked: boolean) => void,
  ) => (
    <button
      ref={(element) => controls.set(id, element)}
      type="button"
      role="switch"
      id={id}
      aria-checked={checked() ? "true" : "false"}
      class="sidebar-session-menu-switch"
      onClick={() => onChange(!checked())}
    >
      <span>{label()}</span>
      <span inert aria-hidden="true">
        <SettingsToggle checked={checked()} ariaLabel={label()} onChange={() => undefined} />
      </span>
    </button>
  );
  return (
    <SidebarSessionFilterPopover
      class="sidebar-session-sort-menu"
      anchor={menus.triggers.get("sessionSort") ?? null}
      label={t("chat.sidebar.sortSessions")}
      initialFocus={() => statusInputs.get(host.sessionsStatusFilter)}
      focusTargets={() => [
        ...statusInputs.values(),
        ...controls.values(),
        ...[...pickers.values()].flatMap((picker) => picker.elements()),
      ]}
      onClose={menus.positionedMenuHandlers("sessionSort").onClose}
      content={
        <>
          <section
            class="sidebar-session-menu-section"
            aria-labelledby="sidebar-sessions-filters-label"
          >
            <div class="sidebar-session-menu-heading">
              <h3 id="sidebar-sessions-filters-label">{t("chat.sidebar.menuFilters")}</h3>
              {settingsChanged() ? (
                <button
                  ref={(element) => controls.set("reset", element)}
                  type="button"
                  id="sidebar-sessions-reset"
                  class="sidebar-session-menu-reset"
                  onClick={() => {
                    defaultStatus?.focus();
                    setSessionsStatusFilter(host.sessionOrganizer, "active");
                    setSessionsShowCron(host.sessionOrganizer, false);
                    setSessionsShowSystem(host.sessionOrganizer, false);
                    setSessionsShowPreview(host.sessionOrganizer, false);
                    host.setSessionSortMode("created");
                    if (!rosterMode()) {
                      // A displayed default can hide a saved Person choice until owners return.
                      if (grouping() !== "category") {
                        setSessionsGrouping(host.sessionOrganizer, "category");
                      }
                      host.setSessionsEmptyGroupsMode("filtering");
                    }
                  }}
                >
                  {t("common.reset")}
                </button>
              ) : undefined}
            </div>
            <div
              id="sidebar-sessions-status"
              class="sidebar-session-menu-row sidebar-session-menu-row--segmented"
            >
              <span aria-hidden="true" title={t("sessionsView.status")}>
                {t("sessionsView.status")}
              </span>
              <SettingsSegmented
                value={host.sessionsStatusFilter}
                inputRef={(value, element) => {
                  statusInputs.set(value, element);
                  if (value === "active") {
                    defaultStatus = element;
                  }
                }}
                options={SIDEBAR_SESSION_STATUS_OPTIONS.map((value) => {
                  const label =
                    value === "active" ? t("common.active") : t(`sessionsView.${value}`);
                  return { value, label, title: label };
                })}
                ariaLabel={t("sessionsView.status")}
                class="sidebar-session-menu-segmented"
                onChange={(statusFilter) =>
                  setSessionsStatusFilter(host.sessionOrganizer, statusFilter)
                }
              />
            </div>
            {switchItem(
              "sidebar-sessions-cron",
              () => t("sessionsView.showCronSessions"),
              () => host.sessionsShowCron,
              (show) => setSessionsShowCron(host.sessionOrganizer, show),
            )}
            {switchItem(
              "sidebar-sessions-system",
              () => t("sessionsView.showSystemSessions"),
              () => host.sessionsShowSystem,
              (show) => setSessionsShowSystem(host.sessionOrganizer, show),
            )}
          </section>
          <section
            class="sidebar-session-menu-section"
            aria-labelledby="sidebar-sessions-display-label"
          >
            <div class="sidebar-session-menu-heading">
              <h3 id="sidebar-sessions-display-label">{t("chat.sidebar.menuDisplay")}</h3>
            </div>
            {rosterMode() ? undefined : (
              <Picker
                focusRef={(handle) => pickers.set("group", handle)}
                id="sidebar-sessions-group"
                label={t("sessionsView.groupBy")}
                value={grouping()}
                variant="submenu"
                sheet={sheet()}
                showOptionTooltips={false}
                options={[
                  { value: "category", label: t("sessionsView.groupByCategory") },
                  { value: "project", label: t("chat.sidebar.catalogGroupByProject") },
                  ...(peopleSortAvailable()
                    ? [{ value: "person", label: t("sessionsView.groupByPerson") }]
                    : []),
                  { value: "none", label: t("sessionsView.groupByNone") },
                ]}
                onChange={(value) => {
                  // SAFETY: This picker emits only the category, project, person, and none options above.
                  setSessionsGrouping(host.sessionOrganizer, value as SidebarSessionsGrouping);
                }}
              />
            )}
            <Picker
              focusRef={(handle) => pickers.set("sort", handle)}
              id="sidebar-sessions-sort"
              label={t("chat.sidebar.sortBy")}
              value={host.effectiveSessionSortMode()}
              variant="submenu"
              sheet={sheet()}
              showOptionTooltips={false}
              options={SIDEBAR_SESSION_SORT_OPTIONS.filter(
                (option) => option.mode !== "people" || peopleSortAvailable(),
              ).map((option) => ({ value: option.mode, label: t(option.labelKey) }))}
              onChange={(value) => {
                const option = SIDEBAR_SESSION_SORT_OPTIONS.find((entry) => entry.mode === value);
                if (option) {
                  host.setSessionSortMode(option.mode);
                }
              }}
            />
            {rosterMode() ? undefined : (
              <Picker
                focusRef={(handle) => pickers.set("empty", handle)}
                id="sidebar-sessions-empty"
                label={t("sessionsView.hideEmptyGroups")}
                value={host.sessionsEmptyGroupsMode}
                variant="submenu"
                sheet={sheet()}
                showOptionTooltips={false}
                options={EMPTY_GROUPS_OPTIONS.map((option) => ({
                  value: option.mode,
                  label: t(option.labelKey),
                }))}
                onChange={(value) => {
                  const option = EMPTY_GROUPS_OPTIONS.find((entry) => entry.mode === value);
                  if (option && menus.sessionSortMenuPosition === position) {
                    host.setSessionsEmptyGroupsMode(option.mode);
                  }
                }}
              />
            )}
            {switchItem(
              "sidebar-sessions-preview",
              () => t("sessionsView.showSessionPreview"),
              () => host.sessionsShowPreview,
              (show) => setSessionsShowPreview(host.sessionOrganizer, show),
            )}
          </section>
          <footer class="sidebar-session-menu-footer">
            <button
              ref={(element) => controls.set("new-collection", element)}
              type="button"
              class="sidebar-session-filter-footer"
              disabled={!host.connected}
              onClick={() => {
                const context = host.sessionDataContext;
                if (context && host.connected) {
                  menus.closePositionedMenu("sessionSort");
                  void createPersonalSessionGroupActions(context).edit();
                }
              }}
            >
              <span aria-hidden="true">
                <Icon name="plus" />
              </span>
              {t("sessionsView.personalGroupNew")}
            </button>
            <a
              ref={(element) => controls.set("sources", element)}
              id="sidebar-sessions-sources"
              class="sidebar-session-filter-footer"
              href={
                pathForRoute(sessionSources.routeId, host.basePath) +
                sessionSources.search +
                sessionSources.hash
              }
              onClick={(event: MouseEvent) =>
                handleNavigationClick(event, () => {
                  menus.closePositionedMenu("sessionSort");
                  host.onNavigate?.(sessionSources.routeId, {
                    search: sessionSources.search,
                    hash: sessionSources.hash,
                  });
                })
              }
            >
              <span aria-hidden="true">{<Icon name="settings" />}</span>
              {t("chat.sidebar.sessionSources")}
            </a>
          </footer>
        </>
      }
    />
  );
}
