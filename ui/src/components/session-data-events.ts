import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { listen } from "../lib/reactive/listener.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../lib/sessions/catalog-key.ts";
import type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
} from "../lib/sessions/index.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type {
  SidebarSessionOwnerFilter,
  SidebarSessionStatusFilter,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";

// Chat panes announce catalog adoptions so rows bind immediately.
export function subscribeSessionCatalogBrowserEvents(
  onContinued: EventListener,
  onPageActivation: EventListener,
): () => void {
  const stopContinued = listen(document, CATALOG_SESSION_CONTINUED_EVENT, onContinued);
  const stopActivation = listen(document, "visibilitychange", onPageActivation);
  return () => {
    stopContinued();
    stopActivation();
  };
}

type SidebarSessionListOwner = {
  readonly context: ApplicationContext | undefined;
  sessionResultsByAgent: Record<string, NonNullable<SessionListSnapshot["result"]>>;
  sessionsResult: SessionListSnapshot["result"];
  sessionsAgentId: SessionListSnapshot["agentId"];
  sessionsLoading: boolean;
  sessionsStartupPending?: boolean;
  sessionMutationError: string | null;
  expandedAgentId(): string;
  sessionListQuery(agentId: string): SessionListOptions;
  requestSessionDataUpdate(): void;
};

const sidebarSessionErrorOwners = new WeakMap<SidebarSessionListOwner, "list" | "action">();

export function publishSidebarSessionError(
  owner: SidebarSessionListOwner,
  error: string | null,
  source: "list" | "action",
): void {
  if (source === "list" && sidebarSessionErrorOwners.get(owner) === "action") {
    return;
  }
  owner.sessionMutationError = error;
  if (error === null) {
    sidebarSessionErrorOwners.delete(owner);
  } else {
    sidebarSessionErrorOwners.set(owner, source);
  }
}

export function clearSidebarSessionError(owner: SidebarSessionListOwner): void {
  publishSidebarSessionError(owner, null, "action");
  owner.requestSessionDataUpdate();
}

export function publishScopedSessionError(
  owner: SidebarSessionListOwner & {
    isSessionMutationScopeCurrent(scope: SidebarSessionMutationScope): boolean;
  },
  scope: SidebarSessionMutationScope,
  error: unknown,
): void {
  if (owner.isSessionMutationScopeCurrent(scope)) {
    publishSidebarSessionError(owner, formatUiError(error), "action");
    owner.requestSessionDataUpdate();
  }
}

function pruneSidebarAgentSessionCaches(
  owner: SidebarSessionListOwner,
  agentIds: readonly string[],
): void {
  const retainedAgentIds = new Set(agentIds.map(normalizeAgentId));
  const entries = Object.entries(owner.sessionResultsByAgent);
  const retained = entries.filter(([agentId]) => retainedAgentIds.has(agentId));
  if (retained.length !== entries.length) {
    owner.sessionResultsByAgent = Object.fromEntries(retained);
  }
  if (owner.sessionsAgentId && !retainedAgentIds.has(normalizeAgentId(owner.sessionsAgentId))) {
    owner.sessionsResult = null;
    owner.sessionsAgentId = null;
  }
}

export function subscribeSidebarAgentSessionCaches(
  agents: AgentCapability,
  owner: SidebarSessionListOwner,
  notify: () => void,
): () => void {
  const synchronize = () => {
    const roster = agents.state.agentsList;
    // A null roster is transient during reconnect; only a concrete list can evict agent caches.
    if (roster) {
      pruneSidebarAgentSessionCaches(
        owner,
        roster.agents.map((agent) => agent.id),
      );
    }
  };
  synchronize();
  // Prune removed-agent caches before publishing the owner update.
  return agents.subscribe(() => {
    synchronize();
    notify();
  });
}

type SidebarSessionQueryOwner = {
  sidebarSessionOwnerFilter(): SidebarSessionOwnerFilter;
  sidebarSessionStatusFilter(): SidebarSessionStatusFilter;
};

export function hasSidebarListFilter(owner: SidebarSessionQueryOwner): boolean {
  const { ownerId, involvingMe } = owner.sidebarSessionOwnerFilter();
  return owner.sidebarSessionStatusFilter() !== "active" || Boolean(ownerId || involvingMe);
}

export function sidebarSessionListQuery(owner: SidebarSessionQueryOwner, agentId: string) {
  const { ownerId, involvingMe } = owner.sidebarSessionOwnerFilter();
  return {
    source: "sidebar",
    excludeDock: true,
    ownerId: involvingMe ? undefined : ownerId || undefined,
    involvingMe: involvingMe || undefined,
    agentId: ownerId ? undefined : agentId,
    archivedFilter: owner.sidebarSessionStatusFilter(),
    limit: SIDEBAR_SESSION_ROSTER_LIMIT,
    rowMode: "sidebar",
    includeDerivedTitles: true,
    includeLastMessage: true,
  } as const;
}

export function publishSidebarSessionList(
  owner: SidebarSessionListOwner,
  snapshot: SessionListSnapshot,
): void {
  owner.sessionsResult = snapshot.result;
  owner.sessionsAgentId = snapshot.agentId;
  owner.sessionsLoading = snapshot.loading;
  owner.sessionsStartupPending = snapshot.startupPending === true;
  if (snapshot.result && snapshot.agentId) {
    const agentId = normalizeAgentId(snapshot.agentId);
    if (owner.sessionResultsByAgent[agentId] !== snapshot.result) {
      owner.sessionResultsByAgent = { ...owner.sessionResultsByAgent, [agentId]: snapshot.result };
    }
  }
}

export function subscribeFilteredSidebarSessions(
  owner: SidebarSessionListOwner,
  sessions: SessionCapability,
  scope: SessionListOptions,
  isCurrent: () => boolean,
): () => void {
  const bootstrap = owner.context?.connectionBootstrap;
  const apply = (snapshot: SessionListSnapshot) => {
    if (!isCurrent()) {
      return;
    }
    // Keep visible rows across reconnect until the new connection owns a fresh list.
    if (owner.context?.gateway.snapshot.phase !== "connected" && !snapshot.result) {
      return;
    }
    publishSidebarSessionList(owner, snapshot);
    publishSidebarSessionError(owner, snapshot.error, "list");
    owner.requestSessionDataUpdate();
  };
  const unsubscribe = sessions.subscribeList(scope, apply);
  apply(sessions.listSnapshot(scope));
  const stop = () => {
    bootstrap?.cancelQueued(stop);
    unsubscribe();
    owner.sessionsStartupPending = false;
    publishSidebarSessionError(owner, null, "list");
  };
  return stop;
}

export function scheduleFilteredSidebarSessions(
  owner: Pick<SidebarSessionListOwner, "context"> & {
    readonly isSessionDataHostConnected: boolean;
    refreshSidebarSessions(): Promise<void>;
  },
  readSubscription: () => (() => void) | null,
): Promise<void> {
  const context = owner.context;
  const subscription = readSubscription();
  if (!context || !subscription) {
    return Promise.resolve();
  }
  return context.connectionBootstrap.run(
    subscription,
    async () => {
      if (
        owner.context === context &&
        readSubscription() === subscription &&
        owner.isSessionDataHostConnected
      ) {
        await owner.refreshSidebarSessions();
      }
    },
    { background: true },
  );
}

export function refreshSidebarSessionList(
  owner: SidebarSessionListOwner,
  {
    agentId,
    append = false,
    affectedAgentId,
  }: {
    agentId?: string | null;
    append?: boolean;
    affectedAgentId?: string;
  },
): Promise<void> {
  const result = owner.sessionsResult;
  const query = owner.sessionListQuery(agentId ?? owner.expandedAgentId());
  // An omitted cursor falls back to accumulated rows; an explicit null is terminal.
  const offset = result?.nextOffset === undefined ? result?.sessions.length : result.nextOffset;
  if (
    !owner.context?.sessions ||
    (affectedAgentId !== undefined &&
      query.agentId !== undefined &&
      normalizeAgentId(affectedAgentId) !== normalizeAgentId(query.agentId)) ||
    (append &&
      (owner.sessionsLoading ||
        !result?.hasMore ||
        typeof offset !== "number" ||
        query.agentId !== owner.sessionListQuery(owner.expandedAgentId()).agentId))
  ) {
    return Promise.resolve();
  }
  return owner.context.sessions.refreshList({
    ...query,
    ...(append && typeof offset === "number" ? { offset, append: true } : {}),
    force: true,
  });
}

type SessionGatewayEventOwner = {
  publishPresence(payload: unknown): void;
  handleSessionCatalogHostEvent(payload: unknown): void;
};

export function subscribeSessionDataGatewayEvents(
  gateway: ApplicationContext["gateway"],
  owner: SessionGatewayEventOwner,
): () => void {
  return gateway.subscribeEvents((event) => {
    if (event.event === "sessions.catalog.host") {
      if (canCallGatewayMethod(gateway.snapshot, "sessions.catalog.list", "operator.read")) {
        owner.handleSessionCatalogHostEvent(event.payload);
      }
      return;
    }
    if (event.event === "presence") {
      owner.publishPresence(event.payload);
    }
  });
}
