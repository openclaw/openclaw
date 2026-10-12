import { definePanelBridge } from "../solid-panel-bridge.tsx";
import type { BrowserPanelInputs, BrowserPanelPresentation } from "./browser-panel-presentation.ts";
import { BrowserPanelContent } from "./browser-panel-solid.tsx";
import dockStyles from "../dock-panel-solid.css?inline";
import tabStyles from "../panel-tab-strip-solid.css?inline";
import browserStyles from "./browser-panel.css?inline";

export type { BrowserPanelInputs } from "./browser-panel-presentation.ts";

export function defineBrowserPanelElement(
  createController: (element: HTMLElement) => BrowserPanelPresentation,
  tag = "openclaw-browser-panel",
) {
  return definePanelBridge<
    BrowserPanelInputs,
    BrowserPanelPresentation,
    | "browserPanelIsOpen"
    | "toggle"
    | "handleToggleRequest"
    | "selectHostedTab"
    | "closeHostedTab"
    | "requestUpdate"
  >(
    tag,
    (element) => {
      const controller = createController(element);
      // Panel inputs read directly from the bridge. Intercept these writes before
      // its setter hides the page and invalidates the request client's authority.
      for (const key of ["presented", "suppressed"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(element, key);
        if (!descriptor?.get || !descriptor.set) {
          throw new Error(`Browser panel bridge requires the ${key} input accessor`);
        }
        const write = descriptor.set.bind(element);
        Object.defineProperty(element, key, {
          ...descriptor,
          set(value: boolean) {
            controller.beforeVisibilityChange(key, value);
            write(value);
          },
        });
      }
      return controller;
    },
    (controller) => (
      <>
        <style>
          {`${dockStyles}\n${tabStyles}\n${browserStyles}`.replaceAll(
            "openclaw-browser-panel",
            tag,
          )}
        </style>
        <BrowserPanelContent controller={controller} />
      </>
    ),
    {
      properties: {
        client: { default: null, attribute: false },
        available: { default: false, type: Boolean },
        remoteAvailable: { default: true, type: Boolean },
        suppressed: { default: false, type: Boolean },
        resourceBasePath: { default: "", attribute: false },
        authToken: { default: null, attribute: false },
        embedded: { default: false, type: Boolean, reflect: true },
        tabsInHeader: { default: false, type: Boolean },
        presented: { default: false, type: Boolean },
        refreshOnPresentation: { default: true, type: Boolean },
        sessionKey: { default: "", attribute: false },
        sessionTabs: { default: [], attribute: false },
        preferredTab: { default: undefined, attribute: false },
        fixedTab: { default: undefined, attribute: false },
        dashboardTarget: { default: undefined, attribute: false },
      },
      methods: [
        "browserPanelIsOpen",
        "toggle",
        "handleToggleRequest",
        "selectHostedTab",
        "closeHostedTab",
        "requestUpdate",
      ],
      getters: [
        "renderRoot",
        "hasUpdated",
        "hostedTabs",
        "activeHostedTabId",
        "browserPanelController",
      ],
    },
  );
}
