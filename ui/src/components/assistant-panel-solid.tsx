import { onSettled } from "solid-js";
import type { AssistantDockOwner } from "../app/assistant-dock.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import {
  createAssistantPanel,
  type AssistantPanelOwner,
  type AssistantPanelProps,
} from "./assistant-panel-controller.ts";
import { AssistantPanelView } from "./assistant-panel-view.tsx";

type Methods = Pick<AssistantDockOwner, "openSession" | "closeSession"> & {
  toggle(): void;
  handleToggleRequest(event: Event): void;
};
type OpenClawAssistantPanel = SolidBridgeElement<AssistantPanelProps, Methods> & {
  readonly openSessionKey: string | null;
  readonly assistantPanelOpen: boolean;
};

// The host outlives context-only Solid remounts; preserve its dock intent.
const controls = new WeakMap<HTMLElement, AssistantPanelOwner>();
defineSolidBridge<AssistantPanelProps, Methods>(
  "openclaw-assistant-panel",
  (_props, element) => {
    const application = useOptionalApplication();
    const retained = controls.get(element);
    const panel = retained ?? createAssistantPanel(element, onSettled);
    controls.set(element, panel);
    panel.attach(application);
    const state = projectOwner(panel, (owner) => owner);
    Object.defineProperties(element, {
      openSessionKey: { configurable: true, get: () => panel.openSessionKey },
      assistantPanelOpen: { configurable: true, get: () => panel.dockLayout.open },
    });
    return <AssistantPanelView state={state.read} />;
  },
  {
    properties: {
      context: { default: undefined, attribute: false },
      custodianAvailable: { default: false, type: Boolean },
      homeAvailable: { default: false, type: Boolean },
      custodianSuppressed: { default: false, type: Boolean },
      pageSessionKey: { default: "" },
      pageAgentId: { default: "" },
      pageRouteId: { default: "chat" },
      pageRouteFailed: { default: false, type: Boolean },
      minimizeRequestId: { default: 0, type: Number },
      store: { default: undefined, attribute: false },
    },
    propertyChanged: (host) => controls.get(host)?.inputsChanged(),
    methods: {
      openSession: (host, params, activation) =>
        controls.get(host)?.openSession(params, activation),
      closeSession: (host, activation) => controls.get(host)?.closeSession(activation),
      toggle: (host) => controls.get(host)?.toggle(),
      handleToggleRequest: (host, event) => controls.get(host)?.handleToggleRequest(event),
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel": OpenClawAssistantPanel;
  }
}
