import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { createSessionEventRefreshCoordinator } from "../sessions/event-refresh-coordinator.ts";
import {
  appendSessionResults,
  readSessionChangedEvent,
  reconcileSessionChanged,
} from "../sessions/reconcile.ts";
import { createSessionEventSubscriptionOwner } from "../sessions/session-event-subscription.ts";
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
  private abort: AbortController | null = null;
  private cleanup: (() => void) | null = null;
  private involvingMe = false;
  private readonly events = createSessionEventSubscriptionOwner({
    isCurrent: (scope) => this.lifecycle.isCurrent(scope),
    onError: (_scope, subscriptionError) => this.publish({ ...this.current, subscriptionError }),
    retryDelayMs: () => null,
  });
  private readonly refreshEvents = createSessionEventRefreshCoordinator({
    active: true,
    refresh: () => this.refresh(),
  });

  constructor(private readonly context: RosterContext) {}

  get snapshot(): RosterActivitySnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    // Each attachment owns a reference, even if two consumers reuse a callback.
    const notify = () => listener();
    this.listeners.add(notify);
    if (this.listeners.size === 1) {
      const { gateway } = this.context;
      const stopGateway = gateway.subscribe((snapshot) => this.applyGateway(snapshot));
      const stopEvents = gateway.subscribeEvents((event) => this.applyEvent(event));
      const stopAgents = this.context.agents.subscribe(() =>
        this.publishResult(this.current.result),
      );
      const stopIdentities = this.context.agentIdentity.subscribe(() =>
        this.publishResult(this.current.result),
      );
      this.cleanup = () => {
        stopGateway();
        stopEvents();
        stopAgents();
        stopIdentities();
      };
      this.applyGateway(gateway.snapshot);
    }
    return () => {
      if (!this.listeners.delete(notify) || this.listeners.size > 0) {
        return;
      }
      this.cleanup?.();
      this.cleanup = null;
      this.lifecycle.transition({ client: null, phase: "stopped" });
      this.reset();
    };
  }

  private publish(snapshot: RosterActivitySnapshot) {
    this.current = snapshot;
    for (const listener of this.listeners) {
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
    const reconciled = reconcileSessionChanged(this.current.result, event.payload, {
      archivedFilter: "all",
    });
    if (reconciled.result !== this.current.result) {
      this.publishResult(reconciled.result);
    }
    const ended =
      info?.hasActiveRun === false || (info?.status != null && info.status !== "running");
    // Streaming messages do not invalidate the roster. A terminal snapshot can
    // replace a known member just as in the primary session catalog.
    if (
      event.event === "session.message" &&
      (!ended || (reconciled.row && info?.archived !== true && !this.involvingMe))
    ) {
      return;
    }
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
    this.abort?.abort();
    this.abort = null;
    this.events.reset();
    this.refreshEvents.reset();
    this.publish({ ...emptySnapshot, involvingMe: this.involvingMe });
  }

  private applyGateway(snapshot: ApplicationGatewaySnapshot) {
    if (this.lifecycle.transition(snapshot)) {
      this.reset();
      void this.refresh();
    }
    // Also expose connection metadata changes to the views.
    this.publish(this.current);
  }

  async refresh(): Promise<void> {
    const scope = this.lifecycle.capture();
    if (!scope) {
      return;
    }
    this.refreshEvents.absorb();
    void this.events.ensure(scope);
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    this.publish({ ...this.current, loading: true, error: null });
    try {
      const raw = await this.context.agents.ensureList();
      signal.throwIfAborted();
      if (!raw) {
        throw new Error(this.context.agents.state.agentsError ?? t("agentsHome.loadFailed"));
      }
      const agents = selectableAgentsList(raw);
      await this.context.agentIdentity.ensure(agents.agents.map((agent) => agent.id));
      signal.throwIfAborted();
      let result: SessionsListResult | null = null;
      let offset = 0;
      // One shared window: at most 300 rows, with Gateway-pinned rows first.
      // Include archives so the sidebar's status filter needs no second loader.
      for (let page = 0; page < 3; page += 1) {
        const next = await scope.client.request<SessionsListResult>(
          "sessions.list",
          buildSessionListParams({
            includeDerivedTitles: true,
            includeLastMessage: true,
            archivedFilter: "all",
            involvingMe: this.involvingMe,
            limit: 100,
            offset,
          }),
          { signal },
        );
        signal.throwIfAborted();
        result = result ? appendSessionResults(result, next) : next;
        if (!next.hasMore || next.sessions.length === 0) {
          break;
        }
        offset = next.nextOffset ?? offset + next.sessions.length;
      }
      this.publishResult(result);
      this.publish({
        ...this.current,
        loading: false,
      });
    } catch (error) {
      if (!signal.aborted) {
        // Activity failure must not retire otherwise usable agent navigation.
        this.publishResult(this.current.result);
        this.publish({
          ...this.current,
          loading: false,
          error: formatUiError(error, t("agentsHome.loadFailed")),
        });
      }
    } finally {
      if (this.abort === abort) {
        this.abort = null;
      }
    }
  }
}
