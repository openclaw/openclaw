import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { nativePanelTabStripCss as tabStyles } from "../panel-tab-strip-styles.ts";
import { TerminalPanel } from "./terminal-panel-component.tsx";
import type { TerminalInputs } from "./terminal-panel-session-types.ts";
import {
  CATALOG_TERMINAL_READY_TIMEOUT_MS,
  createTerminalPanel,
  type TerminalPanelOwner,
  type TerminalPanelMethods,
} from "./terminal-panel.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";
import dockStyles from "../dock-panel-solid.css?inline";
import terminalStyles from "./terminal-panel.css?inline";

type Host = SolidBridgeElement<TerminalInputs, TerminalPanelMethods>;

// Native calls can arrive before the bridge's first microtask mount.
const owners = new WeakMap<HTMLElement, TerminalPanelOwner>();
function ownerFor(host: Host) {
  const retained = owners.get(host);
  if (retained) {
    return retained;
  }
  const owner = createTerminalPanel(host);
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
  (_props, host) => (
    <>
      <style>{styles}</style>
      <TerminalPanel owner={ownerFor(host)} />
    </>
  ),
  {
    properties: {
      client: { default: null, attribute: false },
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
      createTerminalController: { default: createIsolatedGhosttyTerminal, attribute: false },
      catalogReadyTimeoutMs: { default: CATALOG_TERMINAL_READY_TIMEOUT_MS, attribute: false },
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
