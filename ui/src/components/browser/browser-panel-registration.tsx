import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { nativePanelTabStripCss as tabStyles } from "../panel-tab-strip-styles.ts";
import {
  createBrowserPanelPresentation,
  type BrowserPanelInputs,
  type BrowserPanelMethods,
  type BrowserPanelPresentation,
} from "./browser-panel-presentation.ts";
import { BrowserPanelContent } from "./browser-panel-solid.tsx";
import dockStyles from "../dock-panel-solid.css?inline";
import browserStyles from "./browser-panel.css?inline";

type Host = SolidBridgeElement<BrowserPanelInputs, BrowserPanelMethods>;

const owners = new WeakMap<HTMLElement, BrowserPanelPresentation>();
function ownerFor(host: Host) {
  const retained = owners.get(host);
  if (retained) {
    return retained;
  }
  const owner = createBrowserPanelPresentation(host);
  owners.set(host, owner);
  for (const key of ["hostedTabs", "activeHostedTabId"] as const) {
    Object.defineProperty(host, key, { configurable: true, get: () => owner[key] });
  }
  const bridgePrototype = Object.getPrototypeOf(host);
  Object.defineProperty(host, "updateComplete", {
    configurable: true,
    get: () =>
      Promise.resolve(Reflect.get(bridgePrototype, "updateComplete", host)).then(() =>
        host.isConnected ? owner.updateComplete : false,
      ),
  });
  return owner;
}

export const BrowserPanelHost = defineSolidBridge<BrowserPanelInputs, BrowserPanelMethods>(
  "openclaw-browser-panel",
  (_props, host) => (
    <>
      <style>{`${dockStyles}\n${tabStyles}\n${browserStyles}`}</style>
      <BrowserPanelContent owner={ownerFor(host)} />
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
    propertyChanged: (host, key) => owners.get(host)?.inputsChanged(key),
    methods: {
      browserPanelIsOpen: (host) => ownerFor(host).browserPanelIsOpen(),
      toggle: (host) => ownerFor(host).toggle(),
      handleToggleRequest: (host, event) => ownerFor(host).handleToggleRequest(event),
      selectHostedTab: (host, id) => ownerFor(host).selectHostedTab(id),
      closeHostedTab: (host, id) => ownerFor(host).closeHostedTab(id),
    },
  },
);
