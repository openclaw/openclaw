import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { showToast } from "../lib/toast.ts";
import { renderSidebarPluginNavigationMenu } from "./app-sidebar-nav-menus.tsx";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";

export function renderSidebarPluginNavigationMenuForController(
  controller: SidebarMenusController,
): JSX.Element {
  const position = controller.pluginNavigationMenuPosition;
  if (!position || position.entry.signal.aborted) {
    return undefined;
  }
  const derived1 = createMemo(() => position),
    entry = createMemo(() => derived1().entry);
  const trigger = controller.pluginNavigationMenuTrigger;
  const actions = createMemo(() => entry().value.actions ?? []);
  return renderSidebarPluginNavigationMenu({
    get position() {
      return position;
    },
    get item() {
      return entry().value;
    },
    onSelect: async (id) => {
      if (controller.pluginNavigationMenuPosition !== position) {
        return;
      }
      const action = actions().find((candidate) => candidate.id === id);
      controller.closePositionedMenu("pluginNavigation", { restoreFocus: true });
      if (!action || entry().signal.aborted || !trigger?.isConnected) {
        return;
      }
      try {
        await action.run();
      } catch (error) {
        if (!entry().signal.aborted) {
          controller.host.sessionDataContext?.plugins.reportError(entry().pluginId, error);
          showToast({ message: error instanceof Error ? error.message : String(error) });
        }
      }
    },
    ...controller.positionedMenuHandlers("pluginNavigation"),
  });
}
