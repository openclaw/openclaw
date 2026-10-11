import { untrack } from "solid-js";
import { usePanelController } from "../solid-panel-controller.ts";
import type { DesktopPanelController } from "./desktop-panel-controller.ts";
import { DesktopPresentation } from "./desktop-presentation.tsx";

export function DesktopPanelContent(props: { controller: DesktopPanelController }) {
  const controller = untrack(() => props.controller);
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
