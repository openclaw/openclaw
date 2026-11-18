import type { BrowserPanelElement } from "./browser-panel-presentation.ts";

export type { BrowserPanelElement, BrowserPanelInputs } from "./browser-panel-presentation.ts";
export { BrowserPanelHost } from "./browser-panel-registration.tsx";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-panel": BrowserPanelElement;
  }
}
