import { createEffect, untrack } from "solid-js";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { usePanelController } from "../solid-panel-controller.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import { createDesktopPictureInPicture } from "./desktop-picture-in-picture.ts";
import { DesktopPresentation } from "./desktop-presentation.tsx";

export function DesktopPanelContent(props: { controller: DesktopPanelController }) {
  const controller = untrack(() => props.controller);
  controller.pictureInPicture = createDesktopPictureInPicture(
    controller,
    controller.pictureInPictureSource,
  );
  const fullscreen = createDesktopFullscreen(controller.ownerDocument);
  controller.fullscreenMode = fullscreen;
  createEffect(fullscreen.active, () => controller.view.dockLayout.syncReservation());
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
