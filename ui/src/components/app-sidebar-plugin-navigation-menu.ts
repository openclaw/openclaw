import { nothing } from "lit";
import { showToast } from "../lib/toast.ts";
import { renderSidebarPluginNavigationMenu } from "./app-sidebar-nav-menus.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.ts";

/** Binds the plugin navigation context menu to the sidebar menus controller's open state. */
export function renderSidebarPluginNavigationMenuForController(controller: SidebarMenusController) {
  const position = controller.pluginNavigationMenuPosition;
  if (!position || position.entry.signal.aborted) {
    return nothing;
  }
  const { entry } = position;
  const trigger = controller.pluginNavigationMenuTrigger;
  const actions = entry.value.actions ?? [];
  return renderSidebarPluginNavigationMenu({
    position,
    item: entry.value,
    onSelect: async (id) => {
      if (controller.pluginNavigationMenuPosition !== position) {
        return;
      }
      const action = actions.find((candidate) => candidate.id === id);
      controller.closePositionedMenu("pluginNavigation", { restoreFocus: true });
      if (!action || entry.signal.aborted || !trigger?.isConnected) {
        return;
      }
      try {
        await action.run();
      } catch (error) {
        if (!entry.signal.aborted) {
          controller.host.sessionDataContext?.plugins.reportError(entry.pluginId, error);
          showToast({ message: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    onTabAway: () => trigger?.focus(),
    onClose: (restoreFocus) => {
      if (controller.pluginNavigationMenuPosition === position) {
        controller.closePositionedMenu("pluginNavigation", { restoreFocus });
      }
    },
  });
}
