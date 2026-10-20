import { onSettled } from "solid-js";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { nativeDockPanelCss as dockStyles } from "../dock-panel-styles.ts";
import { nativePanelTabStripCss as tabStyles } from "../panel-tab-strip-styles.ts";
import type { TerminalInputs } from "./terminal-panel-session-types.ts";
import { TerminalPanelHostedActions, TerminalPanelView } from "./terminal-panel-view.tsx";
import {
  createTerminalPanel,
  type TerminalPanelOwner,
  type TerminalPanelMethods,
} from "./terminal-panel.ts";
import terminalStyles from "./terminal-panel.css?inline";

type Host = SolidBridgeElement<TerminalInputs, TerminalPanelMethods>;

// Native calls can arrive before the bridge's first microtask mount.
const owners = new WeakMap<HTMLElement, TerminalPanelOwner>();
function ownerFor(host: Host) {
  const retained = owners.get(host);
  if (retained) {
    return retained;
  }
  const owner = createTerminalPanel(host, onSettled);
  owners.set(host, owner);
  for (const key of [
    "hostedTabs",
    "activeHostedTabId",
    "hostedActions",
    "terminalPanelOpen",
  ] as const) {
    Object.defineProperty(host, key, { configurable: true, get: () => owner[key] });
  }
  const bridgePrototype = Object.getPrototypeOf(host);
  Object.defineProperty(host, "updateComplete", {
    configurable: true,
    get: () =>
      Promise.resolve(Reflect.get(bridgePrototype, "updateComplete", host)).then(
        () => owner.updateComplete,
      ),
  });
  return owner;
}
const styles = `${dockStyles}\n${tabStyles}\n${terminalStyles}`;
export const TerminalPanelHost = defineSolidBridge<TerminalInputs, TerminalPanelMethods>(
  "openclaw-terminal-panel",
  (_props, host) => {
    const content = terminalPanel(ownerFor(host));
    return (
      <>
        <style>{styles}</style>
        {content}
      </>
    );
  },
  {
    properties: {
      client: { default: null, attribute: false },
      gatewayConnected: { default: true, type: Boolean },
      agentId: { default: null, attribute: false },
      sessionKey: { default: null, attribute: false },
      available: { default: false, type: Boolean },
      suppressed: { default: false, type: Boolean },
      themeMode: { default: "dark", attribute: false },
      basePath: { default: "", attribute: false },
      fullscreen: { default: false, type: Boolean, reflect: true },
      embedded: { default: false, type: Boolean, reflect: true },
      onClose: { default: undefined, attribute: false },
      tabsInHeader: { default: false, type: Boolean },
      page: { default: false, type: Boolean },
      routeTarget: { default: null, attribute: false },
    },
    propertyChanged: (host, key) => owners.get(host)?.inputsChanged(key),
    methods: {
      activateTerminalHost: (host) => ownerFor(host).activateTerminalHost(),
      toggle: (host) => ownerFor(host).toggle(),
      closeTerminalPanel: (host) => ownerFor(host).closeTerminalPanel(),
      hideTerminalPanelForUnavailableSurface: (host) =>
        ownerFor(host).hideTerminalPanelForUnavailableSurface(),
      restoreTerminalPanelOpenState: (host) => ownerFor(host).restoreTerminalPanelOpenState(),
      resetTerminalSessionPicker: (host) => ownerFor(host).resetTerminalSessionPicker(),
      findTerminalPanelViewport: (host) => ownerFor(host).findTerminalPanelViewport(),
      selectHostedTab: (host, id) => ownerFor(host).selectHostedTab(id),
      closeHostedTab: (host, id) => ownerFor(host).closeHostedTab(id),
      handleToggleRequest: (host, event) => ownerFor(host).handleToggleRequest(event),
    },
  },
);

function terminalPanel(owner: TerminalPanelOwner) {
  const application = useOptionalApplication();
  owner.bindPresentation();
  const state = projectOwner(owner, (current) => current.viewState);
  onSettled(() => {
    let disposed = false;
    let detach: (() => void) | undefined;
    const connect = () => {
      if (!disposed && owner.inputs.isConnected) {
        detach = owner.attach(application);
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
  // The side-panel header moves this Solid-owned node outside the panel's host.
  <TerminalPanelHostedActions
    view={state.read}
    ref={(element) => {
      owner.hostedActionsContent = element;
    }}
  />;
  return <TerminalPanelView view={state.read} />;
}
