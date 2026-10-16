import { createEffect } from "solid-js";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { usePanelController } from "../solid-panel-controller.ts";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import { createDesktopPictureInPicture } from "./desktop-picture-in-picture.ts";
import { DesktopPresentation } from "./desktop-presentation.tsx";

export function DesktopPanelContent(props: { controller: DesktopPanelController }) {
  const controller = props.controller;
  controller.mobileKeyboard = createDesktopMobileKeyboard(controller.keyboardTarget);
  controller.pictureInPicture = createDesktopPictureInPicture(controller, () => {
    const target = controller.launchTarget;
    return controller.available && target.state === "connected" && target.presented
      ? controller.renderRoot.querySelector<HTMLCanvasElement>(".desktop-surface canvas")
      : null;
  });
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
