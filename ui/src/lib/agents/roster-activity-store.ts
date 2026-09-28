import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "../gateway-connection-lifecycle.ts";
import { createGatewaySetSyncLifecycle } from "../gateway-set-sync-lifecycle.ts";
import { createSessionEventRefreshCoordinator } from "../sessions/event-refresh-coordinator.ts";
import {
  appendSessionResults,
  readSessionChangedEvent,
  reconcileSessionChanged,
} from "../sessions/reconcile.ts";
import { createSessionEventSubscriptionOwner } from "../sessions/session-event-subscription.ts";
import { canApplySessionListSnapshot } from "../sessions/session-list-query.ts";
import { buildSessionListParams } from "../sessions/session-requests.ts";
import { selectableAgentsList } from "./display.ts";
import { agentRosterCards } from "./roster-activity.ts";

type RosterContext = Pick<ApplicationContext, "gateway" | "agents" | "agentIdentity">;
type RosterActivitySnapshot = {
  readonly cards: ReadonlyArray<Readonly<ReturnType<typeof agentRosterCards>[number]>>;
  readonly result: SessionsListResult | null;
  readonly involvingMe: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly subscriptionError: string | null;
};
type RosterRequest = {
  scope: GatewayConnectionScope;
  generation: number;
  involvingMe: boolean;
  completion: ReturnType<typeof createDeferredCore<void>>;
};

const emptySnapshot: RosterActivitySnapshot = {
  cards: [],
  result: null,
  involvingMe: false,
  loading: false,
  error: null,
  subscriptionError: null,
};
const stores = new WeakMap<ApplicationGateway, RosterActivityStore>();

/** One activity window per Gateway, retained only by visible roster consumers. */
export function rosterActivityStore(context: RosterContext): RosterActivityStore {
  let store = stores.get(context.gateway);
  if (!store) {
    store = new RosterActivityStore(context);
    stores.set(context.gateway, store);
  }
  return store;
}

class RosterActivityStore {
  private current = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  private readonly rawRequests = new WeakMap<GatewayBrowserClient, RosterRequest>();
  private activeRequest: RosterRequest | null = null;
  private queued: ReturnType<typeof createDeferredCore<void>> | null = null;
  private generation = 0;
  private pageActive = false;
  private readonly observation: ReturnType<typeof createGatewaySetSyncLifecycle>;
  private involvingMe = false;
  private readonly events = createSessionEventSubscriptionOwner({
    isCurrent: (scope) => this.lifecycle.isCurrent(scope),
    onError: (_scope, subscriptionError) => this.publish({ ...this.current, subscriptionError }),
    retryDelayMs: () => null,
  });
  private readonly refreshEvents = createSessionEventRefreshCoordinator({
    active: false,
    refresh: () => this.refresh(),
  });

  constructor(private readonly context: RosterContext) {
    let stopAgents: (() => void) | undefined;
    let stopIdentities: (() => void) | undefined;
    this.observation = createGatewaySetSyncLifecycle(context.gateway, {
      sync: () => this.syncPageActivity(),
      onSnapshot: (snapshot) => this.applyGateway(snapshot),
      onEvent: (event) => this.applyEvent(event),
      onAttach: () => {
        stopAgents = context.agents.subscribe(() => this.publishResult(this.current.result));
        stopIdentities = context.agentIdentity.subscribe(() =>
          this.publishResult(this.current.result),
        );
      },
      onDetach: () => {
        stopAgents?.();
        stopIdentities?.();
        this.pageActive = false;
        this.refreshEvents.setActive(false);
        this.reset();
      },
    });
  }

  get snapshot(): RosterActivitySnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    // Each attachment owns a reference, even if two consumers reuse a callback.
    const notify = () => listener();
    this.listeners.add(notify);
    if (this.listeners.size === 1) {
      this.observation.attach();
      this.syncPageActivity();
      if (!this.applyGateway(this.context.gateway.snapshot)) {
        void this.refresh();
      }
    }
    return () => {
      if (!this.listeners.delete(notify) || this.listeners.size > 0) {
        return;
      }
      this.observation.detach();
    };
  }

  private publish(snapshot: RosterActivitySnapshot) {
    this.current = snapshot;
    for (const listener of Array.from(this.listeners)) {
      if (this.current !== snapshot) {
        return;
      }
      listener();
    }
  }

  private publishResult(result: SessionsListResult | null) {
    this.publish({
      ...this.current,
      result,
      cards: agentRosterCards(
        this.context.agents.state.agentsList ?? undefined,
        result?.sessions.filter((row) => row.archived !== true) ?? [],
        (id) => this.context.agentIdentity.get(id),
      ),
    });
  }

  private applyEvent(event: GatewayEventFrame) {
    if (
      !this.lifecycle.capture() ||
      (event.event !== "sessions.changed" && event.event !== "session.message")
    ) {
      return;
    }
    const info = readSessionChangedEvent(event.payload);
    // Recaps are absent from this roster's ordinary session-list projection.
    if (event.event === "sessions.changed" && info?.reason === "activity-summary") {
      return;
    }
    const snapshotApplied =
      this.current.error === null &&
      !this.activeRequest &&
      canApplySessionListSnapshot(this.current.result, event.payload, {
        archivedFilter: "all",
        involvingMe: this.involvingMe,
      });
    const reconciled = reconcileSessionChanged(this.current.result, event.payload, {
      archivedFilter: "all",
    });
    if (reconciled.result !== this.current.result) {
      this.publishResult(reconciled.result);
    }
    if (snapshotApplied) {
      return;
    }
    const ended =
      info?.hasActiveRun === false || (info?.status != null && info.status !== "running");
    // Streaming messages do not establish membership; terminal snapshots use
    // the same admission decision as sessions.changed.
    if (event.event === "session.message" && !ended) {
      return;
    }
    this.revokeRequest();
    this.refreshEvents.schedule();
  }

  setInvolvingMe(involvingMe: boolean) {
    if (this.involvingMe === involvingMe) {
      return;
    }
    this.involvingMe = involvingMe;
    this.publish({ ...this.current, result: null, involvingMe });
    void this.refresh();
  }

  private reset() {
    this.revokeRequest();
    this.queued?.resolve();
    this.queued = null;
    this.events.reset();
    this.refreshEvents.reset();
    this.publish({ ...emptySnapshot, involvingMe: this.involvingMe });
  }

  private applyGateway(snapshot: ApplicationGatewaySnapshot): boolean {
    const changed = this.lifecycle.transition(snapshot);
    if (changed) {
      this.reset();
      void this.refresh();
    }
    // Also expose connection metadata changes to the views.
    this.publish(this.current);
    return changed;
  }

  private revokeRequest() {
    this.generation += 1;
    // Revocation retires publication; the raw read still owns completion.
    this.activeRequest = null;
  }

  private canRead(): boolean {
    return (
      this.listeners.size > 0 &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    );
  }

  private syncPageActivity() {
    const active = this.canRead();
    if (!active && this.pageActive) {
      this.revokeRequest();
      if (this.listeners.size > 0 && this.lifecycle.capture()) {
        this.queued ??= createDeferredCore();
      }
      this.publish({ ...this.current, loading: false });
    }
    this.pageActive = active;
    this.refreshEvents.setActive(active);
    if (active) {
      this.startQueuedRefresh();
    }
  }

  refresh(): Promise<void> {
    const scope = this.lifecycle.capture();
    if (!scope || this.listeners.size === 0) {
      return Promise.resolve();
    }
    this.refreshEvents.absorb();
    this.revokeRequest();
    const completion = (this.queued ??= createDeferredCore());
    this.startQueuedRefresh();
    return completion.promise;
  }

  private startQueuedRefresh() {
    const scope = this.lifecycle.capture();
    if (!scope || !this.queued || !this.canRead() || this.rawRequests.has(scope.client)) {
      return;
    }
    this.refreshEvents.absorb();
    const request: RosterRequest = {
      scope,
      generation: this.generation,
      involvingMe: this.involvingMe,
      completion: this.queued,
    };
    this.queued = null;
    this.activeRequest = request;
    // Caller retirement cannot cancel Gateway work. Retain correlation until the
    // raw chain settles, including through same-client reconnects and reattachments.
    this.rawRequests.set(scope.client, request);
    void this.load(request).finally(() => {
      if (this.rawRequests.get(scope.client) === request) {
        this.rawRequests.delete(scope.client);
      }
      if (this.activeRequest === request) {
        this.activeRequest = null;
      }
      request.completion.resolve();
      this.startQueuedRefresh();
    });
  }

  private async load(request: RosterRequest): Promise<void> {
    const { scope } = request;
    const isCurrent = () =>
      this.generation === request.generation &&
      this.activeRequest === request &&
      this.lifecycle.isCurrent(scope) &&
      this.canRead();
    void this.events.ensure(scope);
    this.publish({ ...this.current, loading: true, error: null });
    try {
      const raw = await this.context.agents.ensureList();
      if (!isCurrent()) {
        return;
      }
      if (!raw) {
        throw new Error(this.context.agents.state.agentsError ?? t("agentsHome.loadFailed"));
      }
      const agents = selectableAgentsList(raw);
      await this.context.agentIdentity.ensure(agents.agents.map((agent) => agent.id));
      if (!isCurrent()) {
        return;
      }
      let result: SessionsListResult | null = null;
      let offset = 0;
      // One shared window: at most 300 rows, with Gateway-pinned rows first.
      // Include archives so the sidebar's status filter needs no second loader.
      for (let page = 0; page < 3; page += 1) {
        if (!isCurrent()) {
          return;
        }
        const next = await scope.client.request<SessionsListResult>(
          "sessions.list",
          buildSessionListParams({
            includeDerivedTitles: true,
            includeLastMessage: true,
            archivedFilter: "all",
            involvingMe: request.involvingMe,
            limit: 100,
            offset,
          }),
        );
        if (!isCurrent()) {
          return;
        }
        result = result ? appendSessionResults(result, next) : next;
        if (!next.hasMore || next.sessions.length === 0) {
          break;
        }
        offset = next.nextOffset ?? offset + next.sessions.length;
      }
      this.publishResult(result);
      if (!isCurrent()) {
        return;
      }
      this.publish({
        ...this.current,
        loading: false,
      });
    } catch (error) {
      if (isCurrent()) {
        // Activity failure must not retire otherwise usable agent navigation.
        this.publishResult(this.current.result);
        if (!isCurrent()) {
          return;
        }
        this.publish({
          ...this.current,
          loading: false,
          error: formatUiError(error, t("agentsHome.loadFailed")),
        });
      }
    }
  }
}
