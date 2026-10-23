import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { showToast } from "../lib/toast.ts";
import { SidebarDropdown } from "./app-sidebar-nav-menus.tsx";
import { iconData, type IconName } from "./icon-data.ts";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";
import { Icon } from "./solid/icon.tsx";
import type { MenuItem } from "./solid/menu.tsx";

export function renderSidebarPluginNavigationMenuForMenus(
  menus: SidebarMenus,
  host: SidebarMenusOwner,
  position: NonNullable<SidebarMenus["pluginNavigationMenuPosition"]>,
): JSX.Element {
  if (position.entry.signal.aborted) {
    return undefined;
  }
  const { entry } = position;
  const trigger = menus.triggers.get("pluginNavigation");
  const actions = entry.value.actions ?? [];
  const items = createMemo<MenuItem[]>(() =>
    (entry.value.actions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      class: [
        "sidebar-customize-menu__item",
        { "session-menu__item--destructive": action.destructive },
      ],
      variant: action.destructive ? "danger" : undefined,
      icon:
        action.icon && Object.hasOwn(iconData, action.icon) ? (
          <span class="nav-item__icon" aria-hidden="true">
            <Icon
              name={
                // SAFETY: The preceding own-key guard admits only keys of iconData.
                action.icon as IconName
              }
            />
          </span>
        ) : undefined,
      content: <span class="sidebar-customize-menu__text">{action.label}</span>,
    })),
  );
  const select = async (id: string) => {
    if (menus.pluginNavigationMenuPosition !== position) {
      return;
    }
    const action = actions.find((candidate) => candidate.id === id);
    menus.closePositionedMenu("pluginNavigation", { restoreFocus: true });
    if (!action || entry.signal.aborted || !trigger?.isConnected) {
      return;
    }
    try {
      await action.run();
    } catch (error) {
      if (!entry.signal.aborted) {
        host.sessionDataContext?.plugins.reportError(entry.pluginId, error);
        showToast({ message: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  return (
    <SidebarDropdown
      {...menus.positionedMenuHandlers("pluginNavigation")}
      position={position}
      class="sidebar-customize-menu sidebar-plugin-navigation-menu"
      label={entry.value.label}
      onSelect={(id) => void select(id)}
      items={items()}
    />
  );
}
