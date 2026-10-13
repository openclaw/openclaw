import type { ApplicationContext } from "../app/context.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import type { SessionDataControllerHost } from "./session-data-controller-catalog.ts";
import {
  subscribeSidebarAgentSessionCaches,
  subscribeSessionDataGatewayEvents,
} from "./session-data-controller-events.ts";

type SessionDataSourceOwner = Parameters<typeof subscribeSidebarAgentSessionCaches>[1] &
  Parameters<typeof subscribeSessionDataGatewayEvents>[1] & {
    synchronizeSessionScope(): void;
  };

/** Source lifetimes and the shared render frame; data stays in the session owner. */
export function createSessionDataSubscriptions(
  host: Pick<
    SessionDataControllerHost,
    "requestUpdate" | "updateComplete" | "promoteCreatedSession"
  >,
  owner: SessionDataSourceOwner,
  synchronize: {
    gateway(gateway: ApplicationContext["gateway"]): void;
    sessions(sessions: ApplicationContext["sessions"]): void;
  },
) {
  let invalidateRender: (() => void) | undefined;
  const subscriptionHost = {
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => host.requestUpdate(),
    get updateComplete() {
      return host.updateComplete;
    },
  };
  // Every session source shares one frame; state still updates before its notification.
  const render = new SubscriptionsController(subscriptionHost).watch(
    () => owner,
    (_, notify) => {
      invalidateRender = notify;
      return () => {
        invalidateRender = undefined;
      };
    },
    undefined,
    () => undefined,
  );
  const requestUpdate = () => invalidateRender?.();
  const sources = new SubscriptionsController({ ...subscriptionHost, requestUpdate })
    .effect(
      () => owner.context?.gateway,
      (gateway) => {
        synchronize.gateway(gateway);
        return gateway.subscribe(() => synchronize.gateway(gateway));
      },
    )
    .effect(
      () => owner.context?.sessions,
      (sessions) => {
        synchronize.sessions(sessions);
        return sessions.subscribe(() => synchronize.sessions(sessions));
      },
    )
    .effect(
      () => owner.context?.sessions,
      (sessions) => sessions.subscribeCreated((key) => host.promoteCreatedSession(key)),
    )
    .effect(
      () => owner.context?.gateway,
      (gateway) => subscribeSessionDataGatewayEvents(gateway, owner),
    )
    .watch(
      () => owner.context?.agents,
      (agents, notify) => subscribeSidebarAgentSessionCaches(agents, owner, notify),
    )
    .watchStore(
      () => owner.context?.agentSelection,
      () => owner.synchronizeSessionScope(),
    );
  return {
    requestUpdate,
    connect() {
      render.hostConnected();
      sources.hostConnected();
    },
    update() {
      sources.hostUpdate();
    },
    disconnect(cleanup: () => void) {
      // Retire rendering before data cleanup, then close source subscriptions.
      render.hostDisconnected();
      cleanup();
      sources.hostDisconnected();
    },
  };
}
