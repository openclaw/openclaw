import { ContextNotFoundError } from "@solidjs/signals";
import type { AssistantDockOwner } from "../app/assistant-dock.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { useSolidControllerHost } from "../lit/solid-controller-host.ts";
import {
  AssistantPanelController,
  type AssistantPanelProps,
} from "./assistant-panel-controller.ts";
import { AssistantPanelView } from "./assistant-panel-view.tsx";

type Methods = Pick<AssistantDockOwner, "openSession" | "closeSession"> & {
  toggle(): void;
  handleToggleRequest(event: Event): void;
};
export type OpenClawAssistantPanel = SolidBridgeElement<AssistantPanelProps, Methods> & {
  readonly openSessionKey: string | null;
  readonly assistantPanelOpen: boolean;
};

// The host outlives context-only Solid remounts; preserve its dock intent.
const controls = new WeakMap<HTMLElement, AssistantPanelController>();
export const AssistantPanel = defineSolidBridge<AssistantPanelProps, Methods>(
  "openclaw-assistant-panel",
  (props, element) => {
    // A standalone bridge can connect before the application provider exists.
    let application: ReturnType<typeof useApplication> | undefined;
    try {
      application = useApplication();
    } catch (error) {
      if (!(error instanceof ContextNotFoundError)) {
        throw error;
      }
    }
    const { host, revision } = useSolidControllerHost(() => [
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
    ]);
    const existing = controls.get(element);
    const controller = existing ?? new AssistantPanelController(props, element, host, application);
    if (existing) {
      controller.attach(props, host, application);
    } else {
      controls.set(element, controller);
    }
    Object.defineProperties(element, {
      openSessionKey: { configurable: true, get: () => controller.openSessionKey },
      assistantPanelOpen: { configurable: true, get: () => controller.assistantPanelOpen },
    });
    host.addController({
      hostConnected: () => controller.connected(),
      hostUpdate: () => controller.update(),
      hostDisconnected: () => {
        if (!element.isConnected) {
          controller.disconnected();
        }
      },
    });
    return <AssistantPanelView controller={controller} revision={revision} />;
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
