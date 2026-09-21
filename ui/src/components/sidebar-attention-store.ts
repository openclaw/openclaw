import type { CronCompactJob, ModelAuthStatusResult } from "../api/types.ts";
import { createMentionsCapability, type MentionsCapability } from "../app/mentions.ts";
import type {
  SidebarAttentionStoreController as StoreController,
  SidebarAttentionStoreSources,
} from "../app/sidebar-attention-store.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { subscribeStoredChatOutboxChanges } from "../lib/chat/outbox-store.ts";
import { createInitialCronState, loadCronStatus } from "../lib/cron/index.ts";
import { loadCompactCronJobsPage } from "../lib/cron/jobs.ts";
import { loadModelAuthStatus, nextModelAuthStatusRefreshAt } from "../lib/model-auth.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import {
  dismissSidebarAttention,
  isSidebarAttentionDismissed,
  loadDismissals,
  reconcileSidebarAttentionDismissals,
  resolveSidebarAttentionKey,
  type SidebarAttentionDismissals,
  type SidebarAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  buildUpdateInboxEntry,
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import {
  type CronAttentionJob,
  buildSidebarAttentionEntries,
  compareSidebarAttentionEntries,
} from "./sidebar-attention-items.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

type SidebarAttentionOwner = {
  connectionRevision: number;
  dismissalKey: string | null;
};

const VISIBILITY_REFRESH_MIN_AGE_MS = 60_000;
const IDLE_REFRESH_INTERVAL_MS = 10 * 60_000;

export class SidebarAttentionStoreController implements StoreController {
  readonly mentions: MentionsCapability;
  private cronJobs: CronAttentionJob[] = [];
  private cronSchedulerEnabled: boolean | null = null;
  private modelAuthStatus: ModelAuthStatusResult | null = null;
  private modelAuthAgentId: string | null = null;
  private modelAuthRefreshAt?: number;
  private modelAuthRefreshTimer?: ReturnType<typeof globalThis.setTimeout>;
  private loadedOwner: SidebarAttentionOwner | null = null;
  private loadedClient = this.sources.gateway.snapshot.client;
  private loadedAgentScope = { ...this.sources.agentSelection.state };
  private cronLoadedAtMs = 0;
  private dismissalKey: string | null = null;
  private dismissed: SidebarAttentionDismissals = {};
  private loadGeneration = 0;
  private cronRefresh: { generation: number; requested: boolean } | null = null;
  private cronRefreshNeeded = false;
  private modelAuthRefresh: { generation: number; requested: boolean } | null = null;
  private readonly stopGateway: () => void;
  private readonly stopEvents: () => void;
  private readonly stopSelection: () => void;
  private readonly stopAgents: () => void;
  private readonly stopOverlays: () => void;
  private readonly stopMentions: () => void;
  private readonly stopOutbox: () => void;
  private outboxRuntime: typeof import("../pages/chat/chat-outbox-owner.ts") | null = null;
  private disposed = false;
  private readonly idleRefreshTimer: ReturnType<typeof globalThis.setInterval>;

  constructor(
    private readonly sources: SidebarAttentionStoreSources,
    private readonly onChange: () => void,
  ) {
    // Load with the Inbox, but keep its profile state across presenter unmounts.
    this.mentions = createMentionsCapability(sources.gateway, {
      connectionBootstrap: sources.connectionBootstrap,
    });
    this.loadedClient = null;
    this.stopGateway = sources.gateway.subscribe(() => this.synchronizeGateway());
    this.stopEvents = sources.gateway.subscribeEvents((event) => {
      if (event.event === "cron") {
        this.load(false);
      } else if (event.event === "config.changed" || event.event === "chat.metadata.changed") {
        this.load(true, false);
      }
    });
    this.stopSelection = sources.agentSelection.subscribe(() => this.synchronizeGateway());
    this.stopAgents = sources.agents.subscribe(onChange);
    this.stopOverlays = sources.overlays.subscribe(onChange);
    this.stopMentions = this.mentions.subscribe(onChange);
    this.stopOutbox = subscribeStoredChatOutboxChanges(onChange);
    // Share the chat owner’s live overlays without putting its send graph in shell startup.
    void import("../pages/chat/chat-outbox-owner.ts")
      .then((runtime) => {
        if (!this.disposed) {
          this.outboxRuntime = runtime;
          if (this.buildEntries().some((entry) => entry.type === "outbox")) {
            this.onChange();
          }
        }
      })
      .catch(() => {
        // Chat retains its existing recovery controls if its lazy runtime cannot load.
      });
    document.addEventListener("visibilitychange", this.refreshIfStale);
    globalThis.addEventListener("storage", this.syncDismissalsFromStorage);
    this.idleRefreshTimer = globalThis.setInterval(this.refreshIfStale, IDLE_REFRESH_INTERVAL_MS);
    this.synchronizeGateway();
  }

  get entries(): readonly SidebarInboxEntry[] {
    return this.buildEntries().filter(
      (entry) => !entry.dismissal || !isSidebarAttentionDismissed(this.dismissed, entry.dismissal),
    );
  }

  private owner(): SidebarAttentionOwner {
    return {
      connectionRevision: this.sources.gateway.connectionRevision,
      dismissalKey: resolveSidebarAttentionKey(this.sources.gateway),
    };
  }

  private ownerEquals(left: SidebarAttentionOwner, right: SidebarAttentionOwner): boolean {
    return (
      left.connectionRevision === right.connectionRevision &&
      left.dismissalKey === right.dismissalKey
    );
  }

  private clearHealth(): void {
    this.cronJobs = [];
    this.cronSchedulerEnabled = null;
    this.modelAuthStatus = null;
    this.modelAuthAgentId = null;
    this.modelAuthRefreshAt = undefined;
    this.scheduleModelAuthRefresh();
  }

  private scheduleModelAuthRefresh(): void {
    globalThis.clearTimeout(this.modelAuthRefreshTimer);
    this.modelAuthRefreshTimer = undefined;
    if (this.modelAuthRefreshAt === undefined || document.visibilityState === "hidden") {
      return;
    }
    const delay = this.modelAuthRefreshAt - Date.now();
    if (delay <= 0) {
      this.modelAuthRefreshAt = undefined;
      this.load(true, false);
      return;
    }
    this.modelAuthRefreshTimer = globalThis.setTimeout(
      () => this.scheduleModelAuthRefresh(),
      Math.min(2_147_483_647, delay),
    );
  }

  private cronOwnerByJobId(): ReadonlyMap<string, string> | undefined {
    const selection = this.sources.agentSelection.state;
    const roster = this.sources.agents.state.agentsList;
    if (selection.scopeId !== null || !roster) {
      return undefined;
    }
    const namesByAgentId = new Map(
      roster.agents.map((agent) => [normalizeAgentId(agent.id), normalizeAgentLabel(agent)]),
    );
    const defaultId = normalizeAgentId(roster.defaultId);
    return new Map(
      this.cronJobs.map((job) => {
        const ownerId = normalizeAgentId(job.agentId ?? defaultId);
        return [job.id, namesByAgentId.get(ownerId) ?? ownerId];
      }),
    );
  }

  private buildEntries(): SidebarInboxEntry[] {
    const gateway = this.sources.gateway.snapshot;
    const outbox: Extract<SidebarInboxEntry, { type: "outbox" }>[] =
      this.outboxRuntime
        ?.listChatOutboxAttention({
          client: gateway.client,
          connected: gateway.phase === "connected",
          settings: { gatewayUrl: this.sources.gateway.connection.gatewayUrl },
          assistantAgentId: gateway.assistantAgentId,
          agentsList: this.sources.agents.state.agentsList,
          hello: gateway.hello,
        })
        .map((item) =>
          Object.assign(item, {
            type: "outbox" as const,
            category: "system" as const,
            dismissal: null,
            requiresAction: true,
            severity: item.unconfirmed ? ("warning" as const) : ("error" as const),
          }),
        ) ?? [];
    if (gateway.phase !== "connected") {
      return outbox;
    }
    const overlay = this.sources.overlays.snapshot;
    const updateState = resolveSidebarUpdateAttention(this.sources);
    const update = buildUpdateInboxEntry({
      canDismiss: updateState.canUpdate,
      dismissal: updateState.dismissal,
      forced: updateState.forced,
      requiresAction: updateState.forced || (updateState.canUpdate && updateState.actionable),
      severity: overlay.updateStatusBanner?.tone === "danger" ? "error" : "warning",
      visible: updateState.present,
    });
    const scopeUpgrade = buildScopeUpgradeInboxEntry({
      scopes: gateway.hello?.auth?.scopes,
      state: this.sources.scopeUpgrade.state,
    });
    const attention = buildSidebarAttentionEntries({
      cronJobs: this.cronJobs,
      cronSchedulerEnabled: this.cronSchedulerEnabled,
      cronOwnerByJobId: this.cronOwnerByJobId(),
      modelAuthStatus: this.modelAuthStatus,
      modelAuthAgentId: this.modelAuthAgentId,
      now: Date.now(),
    }).toSorted(compareSidebarAttentionEntries);
    return buildSidebarInboxEntries({
      approvals: overlay.approvalQueue,
      attention,
      outbox,
      mentions: this.mentions.snapshot.items,
      scopeUpgrade,
      update,
    });
  }

  private reconcileDismissals(scope: {
    cronInventoryComplete: boolean;
    modelAuthAgentId: string | null;
  }): void {
    if (!this.dismissalKey) {
      return;
    }
    this.dismissed = reconcileSidebarAttentionDismissals({
      active: this.buildEntries().flatMap((entry) => (entry.dismissal ? [entry.dismissal] : [])),
      key: this.dismissalKey,
      scope,
    });
  }

  private load(refreshModelAuth = true, refreshCron = true): void {
    const gateway = this.sources.gateway.snapshot;
    const client = gateway.client;
    if (gateway.phase !== "connected" || !client) {
      return;
    }
    const owner = this.owner();
    const agentScope = { ...this.sources.agentSelection.state };
    const generation = this.loadGeneration;
    this.loadedOwner = owner;
    this.loadedClient = client;
    this.loadedAgentScope = agentScope;
    const current = () =>
      generation === this.loadGeneration &&
      this.sources.gateway.snapshot.phase === "connected" &&
      this.sources.gateway.snapshot.client === client &&
      this.ownerEquals(owner, this.owner()) &&
      this.sources.agentSelection.state.selectedId === agentScope.selectedId &&
      this.sources.agentSelection.state.scopeId === agentScope.scopeId;
    const publishSource = (scope: {
      cronInventoryComplete: boolean;
      modelAuthAgentId: string | null;
    }) => {
      if (!current()) {
        return;
      }
      if (!scope.modelAuthAgentId) {
        this.cronLoadedAtMs = Date.now();
      }
      this.reconcileDismissals(scope);
      this.onChange();
    };
    // Deferring dispatch still invalidates the pending inventory: its stale
    // response must not retire dismissals saved since the request began.
    if (refreshCron && this.cronRefresh?.generation === generation) {
      this.cronRefresh.requested = true;
    }
    if (refreshCron) {
      this.cronRefreshNeeded = document.visibilityState === "hidden";
    }
    if (refreshCron && !this.cronRefreshNeeded && this.cronRefresh?.generation !== generation) {
      const refresh = { generation, requested: true };
      this.cronRefresh = refresh;
      const canRefreshCron = () => current() && document.visibilityState !== "hidden";
      const run = async () => {
        try {
          // One scope owns both reads. Events during either read request one
          // trailing inventory; retired scopes never drain queued network work.
          while (refresh.requested && current()) {
            if (!canRefreshCron()) {
              this.cronRefreshNeeded = true;
              break;
            }
            refresh.requested = false;
            const cron = createInitialCronState<CronCompactJob>({ client, connected: true });
            cron.canRefresh = canRefreshCron;
            cron.cronAgentId = agentScope.scopeId;
            await Promise.all([loadCompactCronJobsPage(cron), loadCronStatus(cron)]);
            while (
              canRefreshCron() &&
              cron.cronJobsHasMore &&
              !cron.cronJobsError &&
              !refresh.requested
            ) {
              await loadCompactCronJobsPage(cron, { append: true });
            }
            if (current()) {
              if (!cron.cronJobsError && !cron.cronJobsHasMore) {
                this.cronJobs = cron.cronJobs.map((job) => ({
                  id: job.id,
                  name: job.name,
                  agentId: job.agentId,
                  enabled: job.enabled,
                  updatedAtMs: job.updatedAtMs,
                  state: {
                    nextRunAtMs: job.nextRunAtMs ?? undefined,
                    lastRunAtMs: job.lastRunAtMs ?? undefined,
                    lastRunStatus: job.lastRunStatus ?? undefined,
                    runningAtMs: job.runningAtMs,
                    autoDisabled: job.autoDisabled,
                  },
                }));
              }
              if (!cron.cronError) {
                this.cronSchedulerEnabled = cron.cronStatus?.enabled ?? null;
              }
              publishSource({
                // Keep progress visible under sustained events, but only a fresh,
                // successful inventory can establish absence and retire dismissals.
                cronInventoryComplete:
                  agentScope.scopeId === null &&
                  !cron.cronJobsHasMore &&
                  !refresh.requested &&
                  !cron.cronJobsError &&
                  !cron.cronError,
                modelAuthAgentId: null,
              });
              if (cron.cronJobsHasMore && !canRefreshCron()) {
                this.cronRefreshNeeded = true;
              }
            }
          }
        } finally {
          if (this.cronRefresh === refresh) {
            this.cronRefresh = null;
          }
        }
      };
      void (this.sources.connectionBootstrap?.run(refresh, run, { background: true }) ?? run());
    }
    if (
      (refreshModelAuth || agentScope.selectedId !== this.modelAuthAgentId) &&
      agentScope.selectedId
    ) {
      this.modelAuthRefreshAt = undefined;
      this.scheduleModelAuthRefresh();
      if (this.modelAuthRefresh?.generation === generation) {
        // Only explicit freshness loads queue auth work; cron events cannot
        // invalidate a pending auth response or schedule another auth request.
        this.modelAuthRefresh.requested ||= refreshModelAuth;
      } else {
        const refresh = { generation, requested: true };
        const agentId = agentScope.selectedId;
        this.modelAuthRefresh = refresh;
        void (async () => {
          try {
            while (refresh.requested && current()) {
              refresh.requested = false;
              const status = await loadModelAuthStatus(client, { agentId }).catch(() => null);
              if (current()) {
                this.modelAuthStatus = status;
                this.modelAuthAgentId = agentId;
                this.modelAuthRefreshAt = status ? nextModelAuthStatusRefreshAt(status) : undefined;
                this.scheduleModelAuthRefresh();
                publishSource({ cronInventoryComplete: false, modelAuthAgentId: agentId });
              }
            }
          } finally {
            if (this.modelAuthRefresh === refresh) {
              this.modelAuthRefresh = null;
            }
          }
        })();
      }
    } else if (!agentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
    }
  }

  private synchronizeGateway(): void {
    const snapshot = this.sources.gateway.snapshot;
    const key = resolveSidebarAttentionKey(this.sources.gateway);
    if (key !== this.dismissalKey) {
      this.dismissalKey = key;
      this.dismissed = loadDismissals(key);
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.loadGeneration += 1;
      this.loadedOwner = null;
      this.loadedClient = null;
      this.clearHealth();
      this.onChange();
      return;
    }
    const owner = this.owner();
    const agentScope = this.sources.agentSelection.state;
    const ownerChanged = this.loadedOwner !== null && !this.ownerEquals(owner, this.loadedOwner);
    if (ownerChanged) {
      this.clearHealth();
      this.onChange();
    }
    if (
      !ownerChanged &&
      snapshot.client === this.loadedClient &&
      agentScope.selectedId === this.loadedAgentScope.selectedId &&
      agentScope.scopeId === this.loadedAgentScope.scopeId
    ) {
      return;
    }
    let scopeChanged = false;
    if (agentScope.selectedId !== this.loadedAgentScope.selectedId) {
      this.modelAuthStatus = null;
      this.modelAuthAgentId = null;
      scopeChanged = true;
    }
    if (agentScope.scopeId !== this.loadedAgentScope.scopeId) {
      this.cronJobs = [];
      scopeChanged = true;
    }
    if (scopeChanged) {
      this.onChange();
    }
    this.loadGeneration += 1;
    this.modelAuthRefreshAt = undefined;
    this.scheduleModelAuthRefresh();
    this.load();
  }

  private readonly refreshIfStale = () => {
    this.scheduleModelAuthRefresh();
    const stale = Date.now() - this.cronLoadedAtMs >= VISIBILITY_REFRESH_MIN_AGE_MS;
    if (document.visibilityState === "visible" && (this.cronRefreshNeeded || stale)) {
      // Hidden cron events need an immediate catch-up even inside the freshness
      // window, without refreshing independently current model authentication.
      this.load(false);
    }
  };

  private readonly syncDismissalsFromStorage = (event: StorageEvent) => {
    if (this.dismissalKey && (event.key === null || event.key === this.dismissalKey)) {
      this.syncDismissals();
    }
  };

  syncDismissals(): void {
    // The eager facade can run before this controller's Gateway subscription.
    // Retire old-account health and dismissal state before publishing its storage refresh.
    this.synchronizeGateway();
    this.dismissed = loadDismissals(this.dismissalKey);
    this.onChange();
  }

  dismiss(dismissal: SidebarAttentionDismissal): void {
    const run = this.sources.overlays.snapshot.updateRun;
    if (
      dismissal.kind === "updateAvailable" &&
      run &&
      run.status !== "running" &&
      dismissal.signature === JSON.stringify(["run", run.runId])
    ) {
      this.sources.overlays.acknowledgeUpdateRun();
      return;
    }
    if (this.dismissalKey) {
      this.dismissed = dismissSidebarAttention(this.dismissalKey, dismissal);
      this.onChange();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.loadGeneration += 1;
    this.modelAuthRefreshAt = undefined;
    this.scheduleModelAuthRefresh();
    this.stopGateway();
    this.stopEvents();
    this.stopSelection();
    this.stopAgents();
    this.stopOverlays();
    this.stopMentions();
    this.stopOutbox();
    this.mentions.dispose();
    document.removeEventListener("visibilitychange", this.refreshIfStale);
    globalThis.removeEventListener("storage", this.syncDismissalsFromStorage);
    globalThis.clearInterval(this.idleRefreshTimer);
  }
}
