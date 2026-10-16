import { createEffect, untrack } from "solid-js";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { usePanelController } from "../solid-panel-controller.ts";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import { DesktopPresentation } from "./desktop-presentation.tsx";

export function DesktopPanelContent(props: { controller: DesktopPanelController }) {
  const controller = untrack(() => props.controller);
  controller.launcher = createDesktopAppLauncher(() => controller.launchTarget);
  const fullscreen = createDesktopFullscreen(controller.ownerDocument);
  controller.fullscreenMode = fullscreen;
  createEffect(fullscreen.active, () => controller.dockLayout.syncReservation());
  usePanelController(controller);
  return (
    <>
      {controller.read().available &&
        (controller.read().documentMode ||
          controller.read().embedded ||
          controller.read().view.dockLayout.open) && (
          <DesktopPresentation view={controller.read().view} />
        )}
    </>
  );
}
