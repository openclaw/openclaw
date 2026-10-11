import {
  BrowserPanelPresentation,
  type BrowserPanelElement,
} from "./browser-panel-presentation.ts";
import { defineBrowserPanelElement } from "./browser-panel-registration.tsx";

export {
  BrowserPanelPresentation,
  type BrowserPanelElement,
  type BrowserPanelInputs,
} from "./browser-panel-presentation.ts";

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-panel": BrowserPanelElement;
  }
}

export const BrowserPanelHost = defineBrowserPanelElement(
  (element) => new BrowserPanelPresentation(element),
);
