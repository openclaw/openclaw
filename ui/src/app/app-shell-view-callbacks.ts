import { isRouteId } from "../app-routes.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type { OutboxStoreRuntime } from "./app-shell-gateway.ts";
import type { ApplicationContext } from "./context.ts";
import { createUpdateProgressWatcher, type UpdateProgress } from "./update-confirmation.ts";

type ShellViewCallbackHost = {
  readonly context: ApplicationContext | undefined;
  readonly storedOutboxes: ReturnType<OutboxStoreRuntime["read"]> | undefined;
  openNewSession(agentId: string, target?: NewSessionTarget): void;
  toggleNavigationSurface(): void;
};

/** Stable child bindings resolve current owners when invoked, without invalidating every paint. */
export function createShellViewCallbacks(host: ShellViewCallbackHost) {
  return {
    outboxAttentionCountForSession: (sessionKey: string) =>
      host.storedOutboxes?.attentionCountForSession(sessionKey) ?? 0,
    hasSessionDraft: (sessionKey: string) =>
      host.storedOutboxes?.hasSessionDraft(sessionKey) ?? false,
    retryGateway: () => host.context?.gateway.connect(),
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
        host.openNewSession(agentId, target);
      }
    },
    watchUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
      const context = host.context;
      return context ? createUpdateProgressWatcher(context)(listener) : () => undefined;
    },
  };
}

export type ShellViewCallbacks = ReturnType<typeof createShellViewCallbacks>;
