import { listen } from "../../lib/reactive/listener.ts";
import type { createDockLayout } from "../dock-layout.ts";
import { DESKTOP_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import type { DesktopPanelInputs } from "./desktop-panel-inputs.ts";

export type DesktopPanelInputSnapshot = ReturnType<typeof readInputs>;

type DesktopPanelLifecycleOptions = {
  dockLayout: Pick<ReturnType<typeof createDockLayout>, "open" | "connect" | "setOpen">;
  reconcile: (
    next: DesktopPanelInputSnapshot,
    previous: DesktopPanelInputSnapshot | undefined,
  ) => void;
  subscribeClient: (client: NonNullable<DesktopPanelInputs["client"]>) => () => void;
  handleToggleRequest: (event: Event) => void;
  detach: () => void;
};

function readInputs(host: DesktopPanelInputs) {
  return {
    client: host.client,
    sessions: host.sessions,
    available: host.available,
    suppressed: host.suppressed,
    documentMode: host.documentMode,
    requestedSource: host.requestedSource,
    sessionKey: host.sessionKey,
    documentControl: host.documentControl,
    suppliedEnvironments: host.suppliedEnvironments,
    embedded: host.embedded,
    presented: host.presented,
  };
}

/** Mount and publication coordination; the panel owner decides connection changes. */
export function createDesktopPanelLifecycle(
  host: DesktopPanelInputs,
  scheduleAfterRender: (callback: () => void | (() => void)) => void,
  options: DesktopPanelLifecycleOptions,
) {
  let publish: (() => void) | undefined;
  const notify = () => {
    publish?.();
    scheduleReconciliation();
  };
  let mounted = false;
  let pendingReconciliation: (() => void) | undefined;
  let previousInputs: DesktopPanelInputSnapshot | undefined;
  let subscribedClient: DesktopPanelInputs["client"] = null;
  let stopClient: (() => void) | undefined;
  let stops: (() => void)[] = [];
  let surface: HTMLElement | undefined;
  let waitingForSurface: ((target: HTMLElement | undefined) => void) | undefined;

  const surfaceRef = (target: HTMLElement | undefined) => {
    surface = target;
    if (target) {
      waitingForSurface?.(target);
      waitingForSurface = undefined;
    }
  };

  function scheduleReconciliation(): void {
    if (!mounted || pendingReconciliation) {
      return;
    }
    const pending = () => {
      if (pendingReconciliation !== pending) {
        return;
      }
      pendingReconciliation = undefined;
      const next = readInputs(host);
      const previous = previousInputs;
      previousInputs = next;
      options.reconcile(next, previous);
      const client = host.available && host.suppliedEnvironments === null ? host.client : null;
      if (client !== subscribedClient) {
        stopClient?.();
        subscribedClient = client;
        stopClient = client ? options.subscribeClient(client) : undefined;
      }
    };
    pendingReconciliation = pending;
    scheduleAfterRender(pending);
  }

  function detach(): void {
    mounted = false;
    pendingReconciliation = undefined;
    previousInputs = undefined;
    stopClient?.();
    stopClient = undefined;
    subscribedClient = null;
    stops.forEach((stop) => stop());
    stops = [];
    options.detach();
  }

  return {
    notify,
    subscribe(this: void, listener: () => void) {
      publish = listener;
      return () => {
        publish = undefined;
      };
    },
    surface: () => surface,
    surfaceRef,
    waitForSurface: () =>
      new Promise<HTMLElement | undefined>((resolve) => {
        waitingForSurface = resolve;
      }),
    cancelSurfaceWait() {
      waitingForSurface?.(undefined);
      waitingForSurface = undefined;
    },
    attach(retainOpen: boolean): void {
      scheduleAfterRender(() => {
        const open = options.dockLayout.open;
        options.dockLayout.connect();
        if (retainOpen) {
          options.dockLayout.setOpen(open, false);
        }
        mounted = true;
        stops = [
          listen(window, DESKTOP_PANEL_TOGGLE_EVENT, (event) => {
            if (!host.embedded) {
              options.handleToggleRequest(event);
            }
          }),
        ];
        notify();
        return detach;
      });
    },
  };
}
