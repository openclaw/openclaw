import type { JSX } from "@solidjs/web";
import { showToast } from "../lib/toast.ts";
import { renderSidebarPluginNavigationMenu } from "./app-sidebar-nav-menus.tsx";
import type { SidebarMenusOwner } from "./sidebar-menus-types.ts";
import type { SidebarMenus } from "./sidebar-menus.tsx";

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
  return renderSidebarPluginNavigationMenu({
    get position() {
      return position;
    },
    get item() {
      return entry.value;
    },
    onSelect: async (id) => {
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
    },
    ...menus.positionedMenuHandlers("pluginNavigation"),
  });
}
