import { createEffect, createMemo } from "solid-js";
import { listen } from "../../lib/reactive/listener.ts";
import { createDesktopFullscreen } from "../desktop-fullscreen.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import { usePanelController } from "../solid-panel-controller.ts";
import { createDesktopAppLauncher } from "./desktop-app-launcher.ts";
import { createDesktopAudio } from "./desktop-audio.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import { createDesktopPictureInPicture } from "./desktop-picture-in-picture.ts";
import { DesktopPresentation } from "./desktop-presentation.tsx";

export function DesktopPanelContent(props: { controller: DesktopPanelController }) {
  const controller = props.controller;
  controller.audio = createDesktopAudio(controller, controller.audioTarget);
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
  const standalone = createMemo(() => !controller.read().embedded);
  createEffect(standalone, (active) =>
    active ? listen(window, DESKTOP_PANEL_TOGGLE_EVENT, controller.handleToggleRequest) : undefined,
  );
  const sessionClient = createMemo(() => {
    const current = controller.read();
    return current.available && current.suppliedEnvironments === null ? current.client : null;
  });
  createEffect(sessionClient, (client) =>
    client ? controller.sessionSource.subscribe(client) : undefined,
  );
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
