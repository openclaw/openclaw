import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { adoptedCatalogSessionKeys } from "./app-sidebar-session-catalogs.ts";
import type { SessionDataControllerHost } from "./session-data-controller-catalog.ts";
import {
  subscribeSidebarAgentSessionCaches,
  subscribeSessionDataGatewayEvents,
} from "./session-data-controller-events.ts";

type SessionDataSourceOwner = Parameters<typeof subscribeSidebarAgentSessionCaches>[1] &
  Parameters<typeof subscribeSessionDataGatewayEvents>[1] & {
    childSessionRowsByParent: Readonly<Record<string, readonly GatewaySessionRow[]>>;
    activeSessionLineageRoot: GatewaySessionRow | null;
    activeSessionLineageSelectedRow: GatewaySessionRow | null;
    sessionCatalogs: readonly SessionCatalog[];
    synchronizeSessionScope(): void;
  };

function sessionDataLiveFacts(
  owner: SessionDataSourceOwner,
  sessions: ApplicationContext["sessions"],
  referencedKeys: readonly string[],
) {
  const rows = new Map(
    [
      ...(owner.sessionsResult?.sessions ?? []),
      ...Object.values(owner.sessionResultsByAgent).flatMap((result) => result.sessions),
      ...Object.values(owner.childSessionRowsByParent).flat(),
      ...[owner.activeSessionLineageRoot, owner.activeSessionLineageSelectedRow].filter(
        (row): row is GatewaySessionRow => row !== null,
      ),
    ].map((row) => [row.key, row.agentId]),
  );
  for (const key of [...adoptedCatalogSessionKeys(owner.sessionCatalogs), ...referencedKeys]) {
    if (!rows.has(key)) {
      rows.set(key, undefined);
    }
  }
  return JSON.stringify(
    [...rows].flatMap(([key, agentId]) => {
      const archive = sessions.archiveVisibility(key);
      const deletion = sessions.deletionState(key, agentId);
      const pullRequest = sessions.pullRequestSummary(key);
      const prepared = sessions.isPreparedWorkSession(key);
      return archive || deletion || pullRequest || prepared
        ? [[key, archive, deletion, pullRequest, prepared]]
        : [];
    }),
  );
}

/** Source lifetimes and the shared render frame; data stays in the session owner. */
export function createSessionDataSubscriptions(
  host: Pick<
    SessionDataControllerHost,
    "requestUpdate" | "updateComplete" | "promoteCreatedSession" | "sidebarReferencedSessionKeys"
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
        let liveFacts = sessionDataLiveFacts(owner, sessions, host.sidebarReferencedSessionKeys);
        return sessions.subscribe(() => {
          synchronize.sessions(sessions);
          // Pending visibility and PR snapshots publish without replacing roster rows.
          const next = sessionDataLiveFacts(owner, sessions, host.sidebarReferencedSessionKeys);
          if (next !== liveFacts) {
            liveFacts = next;
            requestUpdate();
          }
        });
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
