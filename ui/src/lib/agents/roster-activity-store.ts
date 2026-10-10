import { SESSIONS_LIST_TRANSCRIPT_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { createGatewaySetSyncLifecycle } from "../gateway-set-sync-lifecycle.ts";
import type {
  SessionCapability,
  SessionConnectionScope,
  SessionListSnapshot,
} from "../sessions/session-capability.ts";
import { selectableAgentsList } from "./display.ts";
import { agentRosterCards } from "./roster-activity.ts";

type RosterContext = Pick<ApplicationContext, "gateway" | "agents" | "agentIdentity" | "sessions">;
type RosterActivitySnapshot = {
  readonly cards: ReadonlyArray<Readonly<ReturnType<typeof agentRosterCards>[number]>>;
  readonly result: SessionsListResult | null;
  readonly involvingMe: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly subscriptionError: string | null;
};
type RosterBinding = {
  connection: SessionConnectionScope;
  observation?: ReturnType<SessionCapability["observeList"]>;
  snapshot: SessionListSnapshot;
  requested: boolean;
  metadataLoading: boolean;
  metadataError: string | null;
  request?: Promise<void>;
};

const emptySnapshot: RosterActivitySnapshot = {
  cards: [],
  result: null,
  involvingMe: false,
  loading: false,
  error: null,
  subscriptionError: null,
};
const stores = new WeakMap<SessionCapability, RosterActivityStore>();

/** Visible roster consumers share a capability-owned all-agent window and identity projection. */
export function rosterActivityStore(context: RosterContext): RosterActivityStore {
  let store = stores.get(context.sessions);
  if (!store) {
    store = new RosterActivityStore(context);
    stores.set(context.sessions, store);
  }
  return store;
}

class RosterActivityStore {
  private current = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly observation: ReturnType<typeof createGatewaySetSyncLifecycle>;
  private binding: RosterBinding | null = null;
  private involvingMe = false;

  constructor(private readonly context: RosterContext) {
    let cleanups: Array<() => void> = [];
    this.observation = createGatewaySetSyncLifecycle(context.gateway, {
      sync: () => this.synchronize(),
      onSnapshot: () => this.synchronize(),
      onAttach: () => {
        cleanups = [
          context.agents.subscribe(() => this.project()),
          context.agentIdentity.subscribe(() => this.project()),
          context.sessions.subscribe(() => {
            if (this.current.subscriptionError !== context.sessions.eventSubscriptionError) {
              this.project();
            }
          }),
        ];
      },
      onDetach: () => {
        cleanups.forEach((stop) => stop());
        cleanups = [];
        this.retire();
        this.publish({ ...emptySnapshot, involvingMe: this.involvingMe });
      },
    });
  }

  get snapshot(): RosterActivitySnapshot {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    const notify = () => listener();
    this.listeners.add(notify);
    if (this.listeners.size === 1) {
      this.observation.attach();
      this.synchronize();
    }
    return () => {
      if (this.listeners.delete(notify) && this.listeners.size === 0) {
        this.observation.detach();
      }
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

  private project() {
    const binding = this.binding;
    if (!binding || !this.isCurrent(binding)) {
      this.publish({ ...emptySnapshot, involvingMe: this.involvingMe });
      return;
    }
    const { result, loading, error } = binding.snapshot;
    this.publish({
      result,
      involvingMe: this.involvingMe,
      loading: binding.metadataLoading || loading,
      error: binding.metadataError ?? error,
      subscriptionError: this.context.sessions.eventSubscriptionError,
      cards: agentRosterCards(
        this.context.agents.state.agentsList ?? undefined,
        result?.sessions.filter((row) => row.archived !== true) ?? [],
        (id) => this.context.agentIdentity.get(id),
      ),
    });
  }

  private isCurrent(binding: RosterBinding): boolean {
    return (
      this.binding === binding && this.context.sessions.isConnectionScopeCurrent(binding.connection)
    );
  }

  private retire() {
    const previous = this.binding;
    this.binding = null;
    previous?.observation?.dispose();
  }

  private synchronize() {
    if (this.listeners.size === 0) {
      return;
    }
    if (this.binding && !this.isCurrent(this.binding)) {
      this.retire();
    }
    const connection = this.context.sessions.captureConnectionScope();
    if (!connection) {
      this.project();
      return;
    }
    if (!this.binding) {
      const binding: RosterBinding = {
        connection,
        snapshot: { result: null, agentId: null, loading: false, error: null },
        requested: false,
        metadataLoading: false,
        metadataError: null,
      };
      this.binding = binding;
      // The capability owns one bounded window, including its enriched pages,
      // mutation receipts, event reconciliation, and refresh pacing.
      binding.observation = this.context.sessions.observeList(
        {
          source: "agent-roster",
          rowMode: "compact",
          includeDerivedTitles: true,
          includeLastMessage: true,
          archivedFilter: "all",
          involvingMe: this.involvingMe,
          excludeDock: true,
          limit: 300,
          pageSize: SESSIONS_LIST_TRANSCRIPT_LIMIT,
        },
        (snapshot) => {
          if (this.isCurrent(binding)) {
            binding.snapshot = snapshot;
            this.project();
          }
        },
      );
      if (!this.isCurrent(binding)) {
        binding.observation.dispose();
        return;
      }
    }
    if (!this.binding.requested && this.visible()) {
      void this.refreshBinding(this.binding);
    }
  }

  setInvolvingMe(involvingMe: boolean) {
    if (this.involvingMe !== involvingMe) {
      this.involvingMe = involvingMe;
      this.retire();
      this.project();
      this.synchronize();
    }
  }

  private visible() {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  refresh(): Promise<void> {
    this.synchronize();
    return this.binding && this.visible() ? this.refreshBinding(this.binding) : Promise.resolve();
  }

  private refreshBinding(binding: RosterBinding): Promise<void> {
    if (binding.request) {
      return binding.request;
    }
    binding.requested = true;
    binding.metadataLoading = true;
    binding.metadataError = null;
    binding.request = Promise.resolve()
      .then(async () => {
        try {
          const raw = await this.context.agents.ensureList();
          if (!this.isCurrent(binding)) {
            return;
          }
          if (!raw) {
            throw new Error(this.context.agents.state.agentsError ?? t("agentsHome.loadFailed"));
          }
          await this.context.agentIdentity.ensure(
            selectableAgentsList(raw).agents.map(({ id }) => id),
          );
        } catch (error) {
          if (this.isCurrent(binding)) {
            binding.metadataError = formatUiError(error, t("agentsHome.loadFailed"));
          }
          return;
        } finally {
          binding.metadataLoading = false;
          if (this.isCurrent(binding)) {
            this.project();
          }
        }
        if (this.isCurrent(binding) && this.visible()) {
          // The observation publishes list failures; retirement is not a new view error.
          await binding.observation?.refresh().catch(() => undefined);
        } else if (this.isCurrent(binding)) {
          binding.requested = false;
        }
      })
      .finally(() => {
        binding.request = undefined;
      });
    this.project();
    return binding.request;
  }
}
