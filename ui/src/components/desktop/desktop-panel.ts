import { DesktopPanelController } from "./desktop-panel-controller.ts";
import { defineDesktopPanelElement } from "./desktop-panel-registration.tsx";

export { DesktopPanelController } from "./desktop-panel-controller.ts";

if (!customElements.get("openclaw-desktop-panel")) {
  defineDesktopPanelElement((element) => new DesktopPanelController(element));
}
