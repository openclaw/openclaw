import { isRouteId } from "../app-routes.ts";
import { isGatewayConnectionAttemptPending } from "../lib/gateway-status.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type { ShellNavigationCapability } from "./app-shell-navigation.ts";
import type { ApplicationContext } from "./context.ts";
import type { ControlUiReadinessOutlet } from "./control-ui-readiness.ts";
import { createUpdateProgressWatcher, type UpdateProgress } from "./update-confirmation.ts";

type ShellViewCallbackHost = {
  readonly context: ApplicationContext | undefined;
  readonly routeOutlet?: ControlUiReadinessOutlet;
  readonly shellNavigation: ShellNavigationCapability;
  toggleNavigationSurface(): void;
};

/** Stable child bindings resolve current owners when invoked, without invalidating every paint. */
export function createShellViewCallbacks(host: ShellViewCallbackHost) {
  return {
    getPrimaryChatPane: (sessionKey: string) =>
      host.routeOutlet
        ?.renderedElements?.("openclaw-chat-pane")
        .find(
          (pane) =>
            pane.classList.contains("chat-pane-cache__pane--active") &&
            pane.presented &&
            areUiSessionKeysEquivalent(pane.sessionKey, sessionKey),
        ),
    retryGateway: () => {
      const gateway = host.context?.gateway;
      if (gateway && !isGatewayConnectionAttemptPending(gateway.snapshot)) {
        gateway.connect();
      }
    },
    toggleSidebar: () => host.toggleNavigationSurface(),
    updateSidebarEntries: (entries: string[]) =>
      host.context?.navigation.update({ sidebarEntries: entries }),
    openDevicePairSetup: () => void host.context?.overlays.openDevicePairSetup(),
    preloadRoute: (routeId: string): Promise<void> =>
      isRouteId(routeId)
        ? (host.context?.preload(routeId) ?? Promise.resolve())
        : Promise.resolve(),
    requestOpenNewSession: (agentId: string, target?: NewSessionTarget) => {
      const context = host.context;
      if (
        context &&
        readSessionMethodAccess(context.gateway.snapshot, {
          method: "sessions.create",
          params: {},
          sessionScope: true,
        }).allowed
      ) {
        host.shellNavigation.openNewSession(agentId, target);
      }
    },
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      const context = host.context;
      return context ? createUpdateProgressWatcher(context)(listener) : () => undefined;
    },
  };
}

export type ShellViewCallbacks = ReturnType<typeof createShellViewCallbacks>;
