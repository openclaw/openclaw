import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { pathForRoute } from "../app-route-paths.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { t } from "../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { SETTINGS_ROUTE_TARGETS } from "../pages/config/route-data.ts";
import { SidebarDropdown } from "./app-sidebar-nav-menus.tsx";
import { countSidebarSessionFilters } from "./app-sidebar-session-filter-summary.tsx";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  SIDEBAR_SESSION_STATUS_OPTIONS,
} from "./app-sidebar-session-types.ts";
import type { SidebarFilterMenuView, SidebarMenusController } from "./sidebar-menus-controller.tsx";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";
import { renderCompactSessionMenuFrame } from "./solid/session-menu-compact.tsx";
import { SettingsSegmented, SettingsToggle } from "./solid/settings-ui.tsx";
import {
  SidebarMenuRadioItem,
  SidebarOwnerFilter,
  SidebarOwnerOptions,
} from "./solid/sidebar-owner-filter.tsx";

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

export function renderSidebarSessionGroupMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const menu = controller.sessionGroupMenu;
  if (!menu) {
    return undefined;
  }
  const trigger = controller.sessionGroupMenuTrigger;
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
  ) => (
    <wa-dropdown-item
      class={[
        "session-menu__item",
        { "session-menu__item--destructive": action === "delete-group" },
      ]}
      value={action}
      variant={action === "delete-group" ? "danger" : undefined}
      disabled={!host.connected || Boolean(actionDisabledReasons()[action])}
      title={actionDisabledReasons()[action] ?? undefined}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">
        {icon}
      </span>
      <span class="session-menu__text">{label}</span>
    </wa-dropdown-item>
  );
  return (
    <Show when={menu} keyed>
      {(_identity) => (
        <SidebarDropdown
          position={menu}
          class="session-menu sidebar-session-group-menu"
          label={t("sessionsView.groupMenu", { group: menu.group })}
          onSelect={(item) => {
            const value = item.getAttribute("value") ?? undefined;
            if (
              (value === "group-defaults" ||
                value === "rename-group" ||
                value === "new-group" ||
                value === "delete-group") &&
              !actionDisabledReasons()[value]
            ) {
              controller.closeSessionGroupMenu({ restoreFocus: true });
              switch (value) {
                case "group-defaults":
                  if (groupDefaultsStatus() === "unavailable") {
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
          }}
          onTabAway={() => trigger?.focus()}
          onClose={(restoreFocus) => {
            if (controller.sessionGroupMenu === menu) {
              controller.closeSessionGroupMenu({ restoreFocus });
            }
          }}
          content={
            <>
              {renderAction(
                "group-defaults",
                groupDefaultsStatus() === "unavailable"
                  ? `${t("common.retry")}: ${t("sessionsView.groupDefaultsMenu")}`
                  : t("sessionsView.groupDefaultsMenu"),
                <Icon name="settings" />,
              )}
              {renderAction(
                "rename-group",
                t("sessionsView.renameGroupMenu"),
                <Icon name="edit" />,
              )}
              {renderAction("new-group", t("sessionsView.newGroup"), <Icon name="folder" />)}
              <div class="session-menu__separator" role="separator" />
              {renderAction(
                "delete-group",
                t("sessionsView.deleteGroupMenu"),
                <Icon name="trash" />,
              )}
            </>
          }
        />
      )}
    </Show>
  );
}

export function renderSidebarCatalogViewMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const position = controller.catalogViewMenuPosition;
  if (!position) {
    return undefined;
  }
  const ownerFilter = createMemo(() => ({
    owners: host.sessionOwnershipVisibility.filters ? host.sessionOwnerOptions : [],
    ownerFilterId: host.sessionOwnerFilterActive ? host.sessionOwnerFilterId : null,
    involvingMe: host.sessionInvolvingMeFilterActive,
    selfOwnerId: host.sessionDataContext?.gateway.snapshot.selfUser?.id ?? null,
    compact: isMobileNavLayout(),
  }));
  const setOwnerFilter = (ownerId: string | null, involvingMe = false) => {
    host.setSessionOwnerFilter(ownerId, involvingMe);
    controller.closePositionedMenu("catalogView", { restoreFocus: true });
  };
  const groupingOptions = createMemo(
    () =>
      [
        { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
        { grouping: "person", label: t("chat.sidebar.catalogGroupByPerson") },
        { grouping: "none", label: t("sessionsView.groupByNone") },
      ] as const satisfies ReadonlyArray<{ grouping: CatalogProjectGrouping; label: string }>,
  );
  return (
    <Show when={`${position.catalogId}:${position.x}:${position.y}`} keyed>
      {(_identity) => (
        <SidebarDropdown
          position={position}
          class={`sidebar-session-sort-menu sidebar-catalog-view-menu${ownerFilter().compact ? " session-menu--compact" : ""}`}
          label={t("chat.sidebar.catalogViewOptions")}
          onSelect={(item) => {
            const value = item.getAttribute("value") ?? undefined;
            const view = sidebarFilterMenuViewForValue(value);
            if (view) {
              controller.setFilterMenuView(view);
            } else if (value?.startsWith("grouping:")) {
              host.setCatalogProjectGrouping(
                // SAFETY: This owned menu emits grouping values only from groupingOptions below.
                value.slice("grouping:".length) as CatalogProjectGrouping,
              );
              controller.closePositionedMenu("catalogView", { restoreFocus: true });
            } else if (value?.startsWith("owner:")) {
              setOwnerFilter(value.slice("owner:".length) || null);
            } else if (value === "involving-me") {
              setOwnerFilter(null, true);
            } else if (
              value === "hide-catalog" &&
              controller.catalogViewMenuPosition === position
            ) {
              host.hideSessionCatalog(position.catalogId);
              controller.closePositionedMenu("catalogView");
            }
          }}
          {...controller.positionedMenuHandlers("catalogView")}
          content={
            ownerFilter().compact && controller.filterMenuView === "specific-owner" ? (
              renderCompactSessionMenuFrame(
                <SidebarOwnerOptions {...ownerFilter()} submenu={false} />,
              )
            ) : (
              <>
                <div class="sidebar-session-sort-menu__title">{t("sessionsView.groupBy")}</div>
                <For each={groupingOptions()}>
                  {(option) => (
                    <SidebarMenuRadioItem
                      value={`grouping:${option.grouping}`}
                      checked={host.catalogProjectGrouping === option.grouping}
                      label={option.label}
                    />
                  )}
                </For>
                <SidebarOwnerFilter {...ownerFilter()} />
                <div class="session-menu__separator" role="separator" />
                <wa-dropdown-item class="sidebar-session-sort-menu__item" value="hide-catalog">
                  <span class="session-menu__text">{t("chat.sidebar.hideFromSidebar")}</span>
                </wa-dropdown-item>
              </>
            )
          }
        />
      )}
    </Show>
  );
}

export function renderSidebarSessionSortMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const { host } = controller;
  const position = controller.sessionSortMenuPosition;
  if (!position) {
    return undefined;
  }
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
  const segmented = <T extends string>(
    id: string,
    label: () => string,
    value: () => T,
    options: () => ReadonlyArray<{ value: T; label: string }>,
    onChange: (value: T) => void,
  ) => (
    <div id={id} class="sidebar-session-menu-row">
      <span aria-hidden="true" title={label()}>
        {label()}
      </span>
      <SettingsSegmented
        value={value()}
        options={options().map((option) => ({
          value: option.value,
          label: option.label,
          title: option.label,
        }))}
        ariaLabel={label()}
        class="sidebar-session-menu-segmented"
        onChange={onChange}
      />
    </div>
  );
  const switchItem = (
    id: string,
    label: () => string,
    checked: () => boolean,
    onChange: (checked: boolean) => void,
  ) => (
    <button
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
    <Show when={position} keyed>
      {(_identity) => (
        <SidebarSessionFilterPopover
          class="sidebar-session-sort-menu"
          anchor={controller.sessionSortMenuTrigger}
          label={t("chat.sidebar.sortSessions")}
          onClose={controller.positionedMenuHandlers("sessionSort").onClose}
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
                      type="button"
                      id="sidebar-sessions-reset"
                      class="sidebar-session-menu-reset"
                      onClick={(event) => {
                        event.currentTarget
                          .closest(".sidebar-session-filter-panel")
                          ?.querySelector<HTMLElement>(
                            '#sidebar-sessions-status input[type="radio"][value="active"]',
                          )
                          ?.focus();
                        host.sessionOrganizer.setSessionsStatusFilter("active");
                        host.sessionOrganizer.setSessionsShowCron(false);
                        host.sessionOrganizer.setSessionsShowSystem(false);
                        host.sessionOrganizer.setSessionsShowPreview(false);
                        host.setSessionSortMode("created");
                        if (!rosterMode()) {
                          // A displayed default can hide a saved Person choice until owners return.
                          if (grouping() !== "category") {
                            host.sessionOrganizer.setSessionsGrouping("category");
                          }
                          host.setSessionsEmptyGroupsMode("filtering");
                        }
                      }}
                    >
                      {t("common.reset")}
                    </button>
                  ) : undefined}
                </div>
                {segmented(
                  "sidebar-sessions-status",
                  () => t("sessionsView.status"),
                  () => host.sessionsStatusFilter,
                  () =>
                    SIDEBAR_SESSION_STATUS_OPTIONS.map((value) => ({
                      value,
                      label: value === "active" ? t("common.active") : t(`sessionsView.${value}`),
                    })),
                  (statusFilter) => host.sessionOrganizer.setSessionsStatusFilter(statusFilter),
                )}
                {switchItem(
                  "sidebar-sessions-cron",
                  () => t("sessionsView.showCronSessions"),
                  () => host.sessionsShowCron,
                  (show) => host.sessionOrganizer.setSessionsShowCron(show),
                )}
                {switchItem(
                  "sidebar-sessions-system",
                  () => t("sessionsView.showSystemSessions"),
                  () => host.sessionsShowSystem,
                  (show) => host.sessionOrganizer.setSessionsShowSystem(show),
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
                      host.sessionOrganizer.setSessionsGrouping(value as SidebarSessionsGrouping);
                    }}
                  />
                )}
                <Picker
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
                    const option = SIDEBAR_SESSION_SORT_OPTIONS.find(
                      (entry) => entry.mode === value,
                    );
                    if (option) {
                      host.setSessionSortMode(option.mode);
                    }
                  }}
                />
                {rosterMode() ? undefined : (
                  <Picker
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
                      if (option && controller.sessionSortMenuPosition === position) {
                        host.setSessionsEmptyGroupsMode(option.mode);
                      }
                    }}
                  />
                )}
                {switchItem(
                  "sidebar-sessions-preview",
                  () => t("sessionsView.showSessionPreview"),
                  () => host.sessionsShowPreview,
                  (show) => host.sessionOrganizer.setSessionsShowPreview(show),
                )}
              </section>
              <footer class="sidebar-session-menu-footer">
                <a
                  id="sidebar-sessions-sources"
                  class="sidebar-session-filter-footer"
                  href={
                    pathForRoute(sessionSources.routeId, host.basePath) +
                    sessionSources.search +
                    sessionSources.hash
                  }
                  onClick={(event: MouseEvent) => {
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
                  <span aria-hidden="true">{<Icon name="settings" />}</span>
                  {t("chat.sidebar.sessionSources")}
                </a>
              </footer>
            </>
          }
        />
      )}
    </Show>
  );
}
