import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronCompactJob, CronJob, ModelAuthStatusResult } from "../api/types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { createMentionsCapability, type MentionsCapability } from "../app/mentions.ts";
import { hasOperatorReadAccess, isRestrictedSessionGuest } from "../app/operator-access.ts";
import type {
  SidebarAttentionStoreOwner as StoreOwner,
  SidebarAttentionStoreSources,
} from "../app/sidebar-attention-store.ts";
import { subscribeChatOutboxAttentionChanges } from "../lib/chat/outbox-owner-registry.ts";
import { subscribeStoredChatOutboxChanges } from "../lib/chat/outbox-store.ts";
import { resolveCronJobAttention } from "../lib/cron-status.ts";
import { isCronInventoryInvalidation } from "../lib/cron/inventory-connection.ts";
import { readCompactCronInventory } from "../lib/cron/inventory.ts";
import { isGatewayAvailable } from "../lib/gateway-availability.ts";
import { modelAuthEventInvalidates } from "../lib/model-auth-request-state.ts";
import { loadModelAuthStatus, nextModelAuthStatusRefreshAt } from "../lib/model-auth.ts";
import { listen } from "../lib/reactive/listener.ts";
import {
  deferredCronFailurePrefix,
  dismissSidebarAttention,
  hasDeferredCronFailure,
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
  type SidebarInboxEntry,
} from "./sidebar-attention-entries.ts";
import { buildSidebarAttentionEntries } from "./sidebar-attention-items.ts";
import type { OpenClawIdAttention } from "./sidebar-attention-openclaw-id.ts";
import {
  resolveSidebarHistoricalUpdateAttention,
  resolveSidebarUpdateAttention,
  retainedDismissals,
} from "./sidebar-attention-update.ts";

type SidebarAttentionOwner = {
  connectionRevision: number;
  dismissalKey: string | null;
};

type SidebarCronJob = Pick<CronCompactJob, "id" | "enabled"> & {
  state: Pick<
    CronJob["state"],
    "lastRunStatus" | "lastStatus" | "autoDisabled" | "lastMeaningfulResult"
  >;
};

function isSidebarCronJob(job: unknown): job is SidebarCronJob {
  if (
    !isRecord(job) ||
    typeof job.id !== "string" ||
    !job.id ||
    typeof job.enabled !== "boolean" ||
    !isRecord(job.state)
  ) {
    return false;
  }
  const { lastRunStatus, lastStatus, autoDisabled, lastMeaningfulResult } = job.state;
  return (
    [lastRunStatus, lastStatus].every(
      (value) => value === undefined || value === "ok" || value === "error" || value === "skipped",
    ) &&
    (lastMeaningfulResult === undefined ||
      (isRecord(lastMeaningfulResult) &&
        typeof lastMeaningfulResult.outcome === "string" &&
        ["progress", "done", "blocked", "needs_attention"].includes(lastMeaningfulResult.outcome) &&
        typeof lastMeaningfulResult.summary === "string" &&
        typeof lastMeaningfulResult.atMs === "number" &&
        Number.isFinite(lastMeaningfulResult.atMs))) &&
    (autoDisabled === undefined ||
      (isRecord(autoDisabled) &&
        (autoDisabled.reason === "consecutive-failures" ||
          autoDisabled.reason === "schedule-errors") &&
        typeof autoDisabled.atMs === "number" &&
        Number.isFinite(autoDisabled.atMs) &&
        autoDisabled.atMs >= 0 &&
        typeof autoDisabled.consecutiveErrors === "number" &&
        Number.isSafeInteger(autoDisabled.consecutiveErrors) &&
        autoDisabled.consecutiveErrors > 0))
  );
}

export class SidebarAttentionStoreOwner implements StoreOwner {
  readonly mentions: MentionsCapability;
  readonly #healthyCronJobIds = new Set<string>();
  readonly #failedCronJobIds = new Set<string>();
  #modelAuthStatus: ModelAuthStatusResult | null = null;
  #modelAuthAgentId: string | null = null;
  #modelAuthRefreshAt?: number;
  #healthRefreshTimer?: ReturnType<typeof globalThis.setTimeout>;
  #loadedOwner: SidebarAttentionOwner | null = null;
  private loadedClient = this.sources.gateway.snapshot.client;
  private presentationClient = this.sources.gateway.snapshot.client;
  private presentationScope = gatewayPresentationScope(this.sources.gateway);
  private loadedAgentScope = { ...this.sources.agentSelection.state };
  #dismissalKey: string | null = null;
  #dismissed: SidebarAttentionDismissals = {};
  #cronDismissalImport: { key: string; client: GatewayBrowserClient } | null = null;
  readonly #reviewedOutbox = new Set<string>();
  #loadGeneration = 0;
  #cronRefresh: { generation: number; requested: boolean } | null = null;
  #cronRefreshNeeded = false;
  #cronRetryAt?: number;
  #modelAuthRefresh: { generation: number; agentId: string; requested: boolean } | null = null;
  readonly #stopSubscriptions: Array<() => void>;
  #outboxRuntime: typeof import("../lib/chat/outbox-attention.ts") | null = null;
  #disposed = false;
  #openClawIdAttention: OpenClawIdAttention | null = null;
  #openClawIdReadGeneration = 0;

  constructor(
    private readonly sources: SidebarAttentionStoreSources,
    private readonly onChange: () => void,
  ) {
    // Load with the Inbox, but keep its profile state across presenter unmounts.
    this.mentions = createMentionsCapability(sources.gateway, {
      connectionBootstrap: sources.connectionBootstrap,
    });
    this.loadedClient = null;
    // Reconcile owner scope and publish aggregate attention synchronously for downstream consumers.
    this.#stopSubscriptions = [
      sources.gateway.subscribe(() => this.#synchronizeGateway()),
      sources.config.subscribe(() => this.refreshOpenClawId()),
      sources.gateway.subscribeEvents((event) => {
        if (event.event === "openclawId.people.changed") {
          this.refreshOpenClawId();
        } else if (event.event === "cron") {
          this.#applyCronEvent(event.payload);
          if (document.visibilityState === "hidden") {
            this.#cronRefreshNeeded = true;
          }
        } else if (isCronInventoryInvalidation(event)) {
          this.#load(false);
        } else if (
          modelAuthEventInvalidates(event, sources.agentSelection.state.selectedId ?? undefined)
        ) {
          this.#load(true, false);
        }
      }),
      sources.agentSelection.subscribe(() => this.#synchronizeGateway()),
      sources.agents.subscribe(onChange),
      sources.overlays.subscribe(onChange),
      this.mentions.subscribe(onChange),
      subscribeStoredChatOutboxChanges(onChange),
      subscribeChatOutboxAttentionChanges(onChange),
      listen(document, "visibilitychange", this.#refreshDeferred),
      listen(globalThis, "storage", this.#syncDismissalsFromStorage),
    ];
    // Share the chat owner’s live overlays without putting its send graph in shell startup.
    void import("../lib/chat/outbox-attention.ts")
      .then((runtime) => {
        if (!this.#disposed) {
          this.#outboxRuntime = runtime;
          if (this.#buildEntries().some((entry) => entry.type === "outbox")) {
            this.onChange();
          }
        }
      })
      .catch(() => {
        // Chat retains its existing recovery controls if its lazy runtime cannot load.
      });
    this.#synchronizeGateway();
  }

  get entries(): readonly SidebarInboxEntry[] {
    return this.#buildEntries().filter(
      (entry) =>
        !entry.dismissal ||
        (!isSidebarAttentionDismissed(this.#dismissed, entry.dismissal) &&
          !(
            entry.dismissal.kind === "outbox" && this.#reviewedOutbox.has(entry.dismissal.signature)
          )),
    );
  }

  get hasFailedAutomation(): boolean {
    return this.#failedCronJobIds.size > 0;
  }

  #owner(): SidebarAttentionOwner {
    return {
      connectionRevision: this.sources.gateway.connectionRevision,
      dismissalKey: resolveSidebarAttentionKey(this.sources.gateway),
    };
  }

  #ownerEquals(left: SidebarAttentionOwner, right: SidebarAttentionOwner): boolean {
    return (
      left.connectionRevision === right.connectionRevision &&
      left.dismissalKey === right.dismissalKey
    );
  }

  #clearCronJobs(): void {
    this.#healthyCronJobIds.clear();
    this.#failedCronJobIds.clear();
  }

  #clearHealth(): void {
    this.#openClawIdReadGeneration += 1;
    this.#openClawIdAttention = null;
    this.#clearCronJobs();
    this.#cronRetryAt = undefined;
    this.#modelAuthStatus = null;
    this.#modelAuthAgentId = null;
    this.#modelAuthRefreshAt = undefined;
    this.#scheduleHealthRefresh();
  }

  #scheduleHealthRefresh(): void {
    globalThis.clearTimeout(this.#healthRefreshTimer);
    this.#healthRefreshTimer = undefined;
    if (
      this.#disposed ||
      !isGatewayAvailable(this.sources.gateway.snapshot) ||
      (this.sources.gateway.snapshot.selfUser === undefined && this.#dismissalKey !== null) ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const now = Date.now();
    const refreshAuth = this.#modelAuthRefreshAt !== undefined && this.#modelAuthRefreshAt <= now;
    const retryCron = this.#cronRetryAt !== undefined && this.#cronRetryAt <= now;
    if (refreshAuth || retryCron) {
      this.#load(refreshAuth, retryCron);
      return;
    }
    const refreshAt = Math.min(
      this.#modelAuthRefreshAt ?? Infinity,
      this.#cronRetryAt ?? Infinity,
      this.#openClawIdAttention?.nextChangeAt(now) ?? Infinity,
    );
    if (!Number.isFinite(refreshAt)) {
      return;
    }
    this.#healthRefreshTimer = globalThis.setTimeout(
      () => {
        this.onChange();
        this.#scheduleHealthRefresh();
      },
      Math.min(2_147_483_647, refreshAt - now),
    );
  }

  #buildEntries(): SidebarInboxEntry[] {
    const gateway = this.sources.gateway.snapshot;
    const now = Date.now();
    const outbox: Extract<SidebarInboxEntry, { type: "outbox" }>[] =
      this.#outboxRuntime
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
            dismissal: {
              kind: "outbox" as const,
              signature: JSON.stringify([
                gateway.client?.recoveryScope,
                item.agentId,
                item.sessionKey,
                item.id,
                item.held,
                item.command,
              ]),
            },
            requiresAction: true,
            severity: item.held ? ("warning" as const) : ("error" as const),
          }),
        ) ?? [];
    const overlay = this.sources.overlays.snapshot;
    const update = resolveSidebarUpdateAttention(this.sources);
    const historicalUpdate = resolveSidebarHistoricalUpdateAttention(this.sources);
    // Expected guest permissions are not a browser-repair incident. Profile keeps the explicit request.
    const scopeUpgrade = isRestrictedSessionGuest(gateway.hello?.auth ?? null)
      ? null
      : buildScopeUpgradeInboxEntry({
          scopes: gateway.hello?.auth?.scopes,
          state: this.sources.scopeUpgrade.state,
        });
    const attention = buildSidebarAttentionEntries({
      modelAuthStatus: this.#modelAuthStatus,
      modelAuthAgentId: this.#modelAuthAgentId,
      now,
    });
    return buildSidebarInboxEntries({
      approvals: overlay.approvalQueue,
      attention: [
        ...attention,
        ...(historicalUpdate ? [historicalUpdate] : []),
        ...(this.#openClawIdAttention?.items(now) ?? []),
      ],
      outbox,
      mentions: this.mentions.snapshot.items,
      scopeUpgrade,
      update,
    });
  }

  #reconcileDismissals(modelAuthAgentId: string): void {
    if (!this.#dismissalKey) {
      return;
    }
    this.#dismissed = reconcileSidebarAttentionDismissals({
      active: this.#buildEntries().flatMap(retainedDismissals),
      key: this.#dismissalKey,
      scope: { modelAuthAgentId },
    });
  }

  #applyCronEvent(payload: unknown): void {
    // A pending/partial inventory still needs its trailing read. Applying an event
    // there would let an older page overwrite it or certify missing rows.
    if (
      this.#cronRefresh ||
      this.#cronRefreshNeeded ||
      !isGatewayAvailable(this.sources.gateway.snapshot) ||
      document.visibilityState === "hidden" ||
      !isRecord(payload) ||
      typeof payload.action !== "string" ||
      !["removed", "started", "finished", "scheduled"].includes(payload.action) ||
      !isSidebarCronJob(payload.job) ||
      payload.jobId !== payload.job.id
    ) {
      return;
    }
    const job = payload.job;
    // Only the scoped inventory establishes membership. A late completion can name a removed job.
    if (!this.#failedCronJobIds.delete(job.id) && !this.#healthyCronJobIds.delete(job.id)) {
      return;
    }
    if (payload.action !== "removed") {
      (resolveCronJobAttention(job) ? this.#failedCronJobIds : this.#healthyCronJobIds).add(job.id);
    }
    this.onChange();
  }

  #load(refreshModelAuth = true, refreshCron = true): void {
    const gateway = this.sources.gateway.snapshot;
    const client = gateway.client;
    if (
      !isGatewayAvailable(gateway) ||
      !client ||
      (gateway.selfUser === undefined && this.#dismissalKey !== null) ||
      !hasOperatorReadAccess(gateway.hello?.auth ?? null)
    ) {
      return;
    }
    const owner = this.#owner();
    const agentScope = { ...this.sources.agentSelection.state };
    const generation = this.#loadGeneration;
    this.#loadedOwner = owner;
    this.loadedClient = client;
    this.loadedAgentScope = agentScope;
    const current = () =>
      generation === this.#loadGeneration &&
      isGatewayAvailable(this.sources.gateway.snapshot) &&
      this.sources.gateway.snapshot.client === client &&
      this.#ownerEquals(owner, this.#owner()) &&
      this.sources.agentSelection.state.scopeId === agentScope.scopeId;
    if (refreshCron && this.#cronRefresh?.generation === generation) {
      this.#cronRefresh.requested = true;
    }
    if (refreshCron) {
      this.#cronRetryAt = undefined;
      this.#cronRefreshNeeded = document.visibilityState === "hidden";
    }
    if (refreshCron && !this.#cronRefreshNeeded && this.#cronRefresh?.generation !== generation) {
      const refresh = { generation, requested: true };
      this.#cronRefresh = refresh;
      const canRefreshCron = () => current() && document.visibilityState !== "hidden";
      const run = async () => {
        try {
          // Events during a read request one trailing inventory. Retired scopes
          // never drain queued network work.
          while (refresh.requested && current()) {
            if (!canRefreshCron()) {
              this.#cronRefreshNeeded = true;
              break;
            }
            refresh.requested = false;
            const inventory = await readCompactCronInventory(
              client,
              { agentId: agentScope.scopeId ?? undefined },
              { canRead: canRefreshCron },
            ).catch(() => null);
            if (current()) {
              this.#cronRefreshNeeded = !inventory || !canRefreshCron();
              this.#cronRetryAt = inventory ? undefined : Date.now() + 60_000;
              if (inventory && !this.#cronRefreshNeeded) {
                // Publish membership only after the shared inventory has validated every wire page.
                // Runtime events need job IDs and failure state, never the table's sorted rows.
                this.#clearCronJobs();
                for (const {
                  id,
                  enabled,
                  lastRunStatus,
                  autoDisabled,
                  lastMeaningfulResult,
                } of inventory.jobs) {
                  const failed = resolveCronJobAttention({
                    enabled,
                    state: {
                      lastRunStatus: lastRunStatus ?? undefined,
                      autoDisabled,
                      lastMeaningfulResult,
                    },
                  });
                  (failed ? this.#failedCronJobIds : this.#healthyCronJobIds).add(id);
                }
              }
              this.#scheduleHealthRefresh();
              this.onChange();
            }
          }
        } finally {
          if (this.#cronRefresh === refresh) {
            this.#cronRefresh = null;
          }
        }
      };
      void (this.sources.connectionBootstrap?.run(refresh, run, { background: true }) ?? run());
    }
    if (
      (refreshModelAuth || agentScope.selectedId !== this.#modelAuthAgentId) &&
      agentScope.selectedId
    ) {
      this.#modelAuthRefreshAt = undefined;
      if (
        this.#modelAuthRefresh?.generation === generation &&
        this.#modelAuthRefresh.agentId === agentScope.selectedId
      ) {
        // Only explicit freshness loads queue auth work; cron events cannot
        // invalidate a pending auth response or schedule another auth request.
        this.#modelAuthRefresh.requested ||= refreshModelAuth;
      } else {
        const agentId = agentScope.selectedId;
        const refresh = { generation, agentId, requested: true };
        const currentAuth = () =>
          current() &&
          this.#modelAuthRefresh === refresh &&
          this.sources.agentSelection.state.selectedId === agentId;
        this.#modelAuthRefresh = refresh;
        void (async () => {
          try {
            while (refresh.requested && currentAuth()) {
              refresh.requested = false;
              const status = await loadModelAuthStatus(client, { agentId }).catch(() => null);
              // An unavailable catalog cannot establish that a dismissed warning has cleared.
              if (currentAuth() && status && !status.unavailable) {
                this.#modelAuthStatus = status;
                this.#modelAuthAgentId = agentId;
                this.#modelAuthRefreshAt = nextModelAuthStatusRefreshAt(status);
                this.#reconcileDismissals(agentId);
                this.#scheduleHealthRefresh();
                this.onChange();
              }
            }
          } finally {
            if (this.#modelAuthRefresh === refresh) {
              this.#modelAuthRefresh = null;
            }
          }
        })();
      }
    } else if (!agentScope.selectedId) {
      this.#modelAuthStatus = null;
      this.#modelAuthAgentId = null;
    }
    this.#scheduleHealthRefresh();
  }

  refreshOpenClawId(): void {
    const generation = ++this.#openClawIdReadGeneration;
    const snapshot = this.sources.gateway.snapshot;
    const client = snapshot.client;
    const revision = this.sources.gateway.connectionRevision;
    const scope = gatewayPresentationScope(this.sources.gateway);
    const current = () =>
      !this.#disposed &&
      generation === this.#openClawIdReadGeneration &&
      this.sources.config.current.openclawIdEnabled === true &&
      this.sources.gateway.snapshot.phase === "connected" &&
      this.sources.gateway.snapshot.client === client &&
      this.sources.gateway.connectionRevision === revision &&
      gatewayPresentationScope(this.sources.gateway) === scope;
    if (!client || !current() || !hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
      if (this.#openClawIdAttention !== null) {
        this.#openClawIdAttention = null;
        this.onChange();
      }
      return;
    }
    void (async () => {
      const { readOpenClawIdAttention } = await import("./sidebar-attention-openclaw-id.ts");
      if (!current()) {
        return;
      }
      const attention = await readOpenClawIdAttention(client, current);
      if (attention && current()) {
        this.#openClawIdAttention = attention;
        // Join requests count down and expire without a Gateway event; keep each row current.
        this.#scheduleHealthRefresh();
        this.onChange();
      }
    })().catch(() => {
      // A failed read is not evidence that a known key problem was repaired.
    });
  }

  async #importCronDismissals(): Promise<void> {
    const gateway = this.sources.gateway;
    const { client } = gateway.snapshot;
    const key = resolveSidebarAttentionKey(gateway);
    const revision = gateway.connectionRevision;
    const isCurrent = () =>
      !this.#disposed &&
      gateway.snapshot.client === client &&
      gateway.connectionRevision === revision &&
      resolveSidebarAttentionKey(gateway) === key &&
      isGatewayAvailable(gateway.snapshot) &&
      hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null);
    if (
      !client ||
      !key ||
      !isCurrent() ||
      (this.#cronDismissalImport?.key === key && this.#cronDismissalImport.client === client) ||
      (!this.#dismissed.cronFailed?.length && !hasDeferredCronFailure(key))
    ) {
      return;
    }
    const pending = { key, client };
    this.#cronDismissalImport = pending;
    try {
      const { importCronFailureDismissals } = await import("./sidebar-cron-failure-dismissals.ts");
      await importCronFailureDismissals(client, key, isCurrent);
    } catch {
      // The browser records remain available if the lazy import fails.
    } finally {
      if (this.#cronDismissalImport === pending) {
        this.#cronDismissalImport = null;
      }
    }
  }

  #synchronizeGateway(): void {
    const snapshot = this.sources.gateway.snapshot;
    const scope = gatewayPresentationScope(this.sources.gateway);
    const identityChanged =
      this.presentationClient !== snapshot.client || this.presentationScope !== scope;
    this.presentationClient = snapshot.client;
    this.presentationScope = scope;
    const identityPending =
      snapshot.phase === "connected" &&
      snapshot.selfUser === undefined &&
      this.#dismissalKey !== null &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null);
    const key =
      (snapshot.phase !== "connected" || identityPending) && !identityChanged
        ? this.#dismissalKey
        : resolveSidebarAttentionKey(this.sources.gateway);
    const dismissalKeyChanged = key !== this.#dismissalKey;
    if (dismissalKeyChanged) {
      this.#dismissalKey = key;
      this.#dismissed = loadDismissals(key);
    }
    if (
      (snapshot.phase !== "connected" || identityPending) &&
      snapshot.client &&
      !identityChanged
    ) {
      this.#loadGeneration += 1;
      this.loadedClient = null;
      this.#openClawIdReadGeneration += 1;
      this.#openClawIdAttention = null;
      this.#scheduleHealthRefresh();
      this.onChange();
      return;
    }
    if (
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      !hasOperatorReadAccess(snapshot.hello?.auth ?? null)
    ) {
      this.#loadGeneration += 1;
      this.#loadedOwner = null;
      this.loadedClient = null;
      this.#clearHealth();
      this.onChange();
      return;
    }
    if (!isGatewayAvailable(snapshot)) {
      this.#loadGeneration += 1;
      this.loadedClient = null;
      this.#scheduleHealthRefresh();
      return;
    }
    if (dismissalKeyChanged || snapshot.client !== this.loadedClient) {
      void this.#importCronDismissals();
    }
    const owner = this.#owner();
    const agentScope = this.sources.agentSelection.state;
    const ownerChanged =
      identityChanged ||
      (this.#loadedOwner !== null && !this.#ownerEquals(owner, this.#loadedOwner));
    if (ownerChanged) {
      this.#clearHealth();
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
    if (
      !ownerChanged &&
      snapshot.client === this.loadedClient &&
      agentScope.scopeId === this.loadedAgentScope.scopeId
    ) {
      // Chat selection changes auth ownership, not the Automations filter.
      this.#modelAuthStatus = null;
      this.#modelAuthAgentId = null;
      this.#load(true, false);
      this.onChange();
      return;
    }
    let scopeChanged = false;
    if (agentScope.selectedId !== this.loadedAgentScope.selectedId) {
      this.#modelAuthStatus = null;
      this.#modelAuthAgentId = null;
      scopeChanged = true;
    }
    if (agentScope.scopeId !== this.loadedAgentScope.scopeId) {
      this.#clearCronJobs();
      scopeChanged = true;
    }
    if (scopeChanged) {
      this.onChange();
    }
    this.#loadGeneration += 1;
    this.#modelAuthRefreshAt = undefined;
    this.#cronRetryAt = undefined;
    this.#scheduleHealthRefresh();
    this.#load();
    this.refreshOpenClawId();
  }

  readonly #refreshDeferred = () => {
    this.#scheduleHealthRefresh();
    if (document.visibilityState === "visible") {
      this.refreshOpenClawId();
      this.onChange();
      if (this.#cronRefreshNeeded) {
        // Catch up hidden changes or failed reads without reloading unchanged inventory.
        this.#load(false);
      }
    }
  };

  readonly #syncDismissalsFromStorage = (event: StorageEvent) => {
    const key = this.#dismissalKey;
    if (key && (event.key === null || event.key === key)) {
      this.syncDismissals();
      void this.#importCronDismissals();
    } else if (key && event.key?.startsWith(deferredCronFailurePrefix(key))) {
      void this.#importCronDismissals();
    }
  };

  syncDismissals(): void {
    // The eager facade can run before this controller's Gateway subscription.
    // Retire old-account health and dismissal state before publishing its storage refresh.
    this.#synchronizeGateway();
    this.#dismissed = loadDismissals(this.#dismissalKey);
    this.onChange();
  }

  dismiss(dismissal: SidebarAttentionDismissal): void {
    const run = this.sources.overlays.snapshot.updateRun;
    if (dismissal.kind === "outbox") {
      // Offline review has no authenticated storage key; retain it through reconnect.
      this.#reviewedOutbox.add(dismissal.signature);
      this.onChange();
    }
    if (
      dismissal.kind === "updateAvailable" &&
      run &&
      run.status !== "running" &&
      dismissal.signature === JSON.stringify(["run", run.runId])
    ) {
      this.sources.overlays.acknowledgeUpdateRun();
      return;
    }
    if (this.#dismissalKey) {
      this.#dismissed = dismissSidebarAttention(this.#dismissalKey, dismissal);
      this.onChange();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#loadGeneration += 1;
    this.#modelAuthRefreshAt = undefined;
    this.#scheduleHealthRefresh();
    for (const stop of this.#stopSubscriptions) {
      stop();
    }
    this.mentions.dispose();
  }
}
