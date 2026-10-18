import { createEffect, onSettled, untrack } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { DockResizer } from "../dock-layout-solid.tsx";
import { nativePanelTabStripCss as tabStyles } from "../panel-tab-strip-styles.ts";
import {
  createBrowserPanelPresentation,
  type BrowserPanelInputs,
  type BrowserPanelMethods,
  type BrowserPanelPresentation,
} from "./browser-panel-presentation.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";
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

function BrowserPanelContent(props: { owner: BrowserPanelPresentation }) {
  // The native bridge retains this synchronous owner for the host's lifetime.
  const owner = untrack(() => props.owner);
  const state = projectOwner(owner, (current) => current);
  // Native presentation and viewport geometry follow the committed DOM.
  createEffect(state.revision, () => owner.rendered());
  onSettled(() => {
    let disposed = false;
    let detach: (() => void) | undefined;
    const connect = () => {
      if (!disposed && owner.inputs.isConnected) {
        detach = owner.attach();
      }
    };
    // Direct Solid hosts settle before their parent inserts them.
    if (owner.inputs.isConnected) {
      connect();
    } else {
      queueMicrotask(connect);
    }
    return () => {
      disposed = true;
      detach?.();
    };
  });
  const panel = state.read;
  return (
    <>
      {panel().inputs.available && (panel().inputs.embedded || panel().dockLayout.open) ? (
        <BrowserPanelChrome
          controller={panel().browser}
          dock={panel().dockLayout.dock}
          height={panel().dockLayout.height}
          width={panel().dockLayout.width}
          onDockChange={(dock) => panel().dockLayout.setDock(dock)}
          onClose={() => panel().closePanel()}
          resizer={
            <DockResizer
              controller={panel().dockLayout}
              classPrefix="bp"
              label={t("browser.resize")}
            />
          }
          embedded={panel().inputs.embedded}
          tabsInHeader={panel().inputs.tabsInHeader}
        />
      ) : null}
    </>
  );
}
