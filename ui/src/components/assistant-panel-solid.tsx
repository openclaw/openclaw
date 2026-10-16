import { createEffect, createSignal, onSettled } from "solid-js";
import type { AssistantDockOwner } from "../app/assistant-dock.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import {
  CHAT_ROUTE_READY_EVENT,
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import { subscribePluginHelp } from "../pages/custodian/plugin-help-state.ts";
import {
  createAssistantPanel,
  type AssistantPanelOwner,
  type AssistantPanelProps,
} from "./assistant-panel-controller.ts";
import { AssistantPanelView } from "./assistant-panel-view.tsx";
import { CUSTODIAN_PANEL_TOGGLE_EVENT, HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";

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
  (props, element) => {
    const application = useOptionalApplication();
    const retained = controls.get(element);
    const panel = retained ?? createAssistantPanel(element);
    controls.set(element, panel);
    panel.attach(application);
    const state = projectOwner(panel, (owner) => owner);
    const [mounted, setMounted] = createSignal(false);
    Object.defineProperties(element, {
      openSessionKey: { configurable: true, get: () => panel.openSessionKey },
      assistantPanelOpen: { configurable: true, get: () => panel.dockLayout.open },
    });
    // Route/availability changes reconcile the synchronous dock and navigation owner.
    createEffect(
      () =>
        mounted() && [
          props.context,
          props.custodianAvailable,
          props.homeAvailable,
          props.custodianSuppressed,
          props.pageSessionKey,
          props.pageAgentId,
          props.pageRouteId,
          props.pageRouteFailed,
          props.minimizeRequestId,
          props.store,
        ],
      (ready) => {
        if (ready) {
          panel.refresh();
        }
      },
    );
    createEffect(
      () => (mounted() ? ([props.context ?? application, props.store] as const) : undefined),
      (sources) => {
        if (!sources) {
          return undefined;
        }
        const [context, store] = sources;
        const stops = [
          context?.assistantDock?.attach(panel),
          context ? subscribePluginHelp(context, panel.refresh) : undefined,
          ...[
            store,
            context?.agentSelection,
            context?.agents,
            context?.theme,
            context?.gateway,
          ].map((source) => source?.subscribe(panel.refresh)),
        ];
        panel.refresh();
        return () => stops.forEach((stop) => stop?.());
      },
    );
    onSettled(() => {
      // Restore persisted geometry/open state before applying route suppression.
      const open = panel.dockLayout.open;
      panel.dockLayout.hostConnected();
      // A retained host keeps its explicit or suppressed visibility through remounts.
      if (retained) {
        panel.dockLayout.setOpen(open, false);
      }
      setMounted(true);
      const stops = [
        panel.contentLoader.subscribe(panel.notify),
        listen(document, CHAT_ROUTE_READY_EVENT, panel.refresh),
        listen(document, CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, panel.refresh),
        listen(window, CUSTODIAN_PANEL_TOGGLE_EVENT, panel.handleToggleRequest),
        listen(window, HOME_PANEL_TOGGLE_EVENT, panel.handleToggleRequest),
      ];
      panel.refresh();
      return () => {
        stops.forEach((stop) => stop());
        state.dispose();
        panel.dockLayout.hostDisconnected();
        // Context replacement remounts Solid without retiring the element's dock intent.
        if (!element.isConnected) {
          panel.detach();
        }
      };
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
