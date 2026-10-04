import type { RouteLocation } from "@openclaw/uirouter";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { activityPersonFromPath, activityPersonLocation } from "../../app-route-paths.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { createSessionEventRefreshCoordinator } from "../../lib/sessions/event-refresh-coordinator.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import {
  createSessionRowProvenance,
  createSessionWriteObservation,
} from "../../lib/sessions/session-row-provenance.ts";
import { activityPulseBoundaries } from "./activity-pulse-window.ts";
import {
  readCurrentWorkChange,
  readCurrentWorkChanges,
  currentWorkIdentity,
  isOlderCurrentWorkChange,
  CURRENT_WORK_CHANGE_LIMIT,
  reconcileCurrentWork,
  type CurrentWorkChange,
  type CurrentWorkFence,
} from "./current-work.ts";
import {
  canonicalSessionActivityLocation,
  reconcileSessionActivity,
  reconcileSessionActivityRead,
  sessionActivityLocation,
  type SessionActivityFilters,
} from "./session-activity.ts";

type ActivityQuery = SessionActivityFilters | "current";
const ACTIVITY_FALLBACK_REFRESH_MS = 60_000;
export const ACTIVITY_SUMMARY_ENSURE_METHOD = "sessions.activitySummary.ensure";
const SUMMARY_BATCH_SIZE = 20;

function sameActiveSnapshot(change: CurrentWorkChange | undefined, identity: string): boolean {
  return Boolean(
    change?.snapshot &&
    !change.isAncestorReference &&
    change.reason !== "delete" &&
    change.hasActiveRun === true &&
    currentWorkIdentity(change) === identity,
  );
}

function summaryRowKey(row: Pick<GatewaySessionRow, "key" | "agentId">): string {
  return JSON.stringify([row.agentId ?? parseAgentSessionKey(row.key)?.agentId, row.key]);
}

function summaryRevision(row: GatewaySessionRow): string {
  return JSON.stringify([
    row.sessionId,
    row.updatedAt,
    row.lastActivityAt,
    row.activitySummary?.updatedAt,
  ]);
}

/** The Activity query owns its page; selecting a person must not replace the sidebar roster. */
export class SessionActivityController implements ReactiveController {
  result?: SessionsListResult;
  error?: string;
  incomplete = false;
  private requestState: "idle" | "loading" | "retrying" = "idle";

  get loading(): boolean {
    return this.requestState !== "idle" || this.incomplete;
  }

  get retrying(): boolean {
    return this.requestState === "retrying";
  }
  private client: GatewayBrowserClient | null = null;
  private queryKey?: string;
  private pending?: {
    controller: AbortController;
    completion: ReturnType<typeof createDeferredCore<void>>;
  };
  private summaryPending?: AbortController;
  private readonly summaryAttempts = new Map<string, string>();
  private readonly summaryRetries = new Set<string>();
  private canEnsureSummaries = false;
  private filters: ActivityQuery | null = null;
  private bucketRollover?: ReturnType<typeof setTimeout>;
  private pendingChanges: CurrentWorkChange[] = [];
  private fallbackRefresh?: ReturnType<typeof setTimeout>;
  private changesOverflowed = false;
  private readonly currentWorkFences = new Map<string, CurrentWorkFence>();
  private retirementOverflowed = false;
  private readonly historyRows = createSessionRowProvenance();
  private historyRevision = 0;
  private normalizedLocation = "";
  private readonly observesPageLifecycle =
    typeof document !== "undefined" && typeof globalThis.addEventListener === "function";
  private pageActive = !this.observesPageLifecycle || document.visibilityState !== "hidden";
  private readonly eventRefresh = createSessionEventRefreshCoordinator({
    active: this.pageActive,
    refresh: () => this.load(this.client, this.filters, "refresh"),
  });

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {
    this.updatePageLifecycleListeners(true);
    if (this.observesPageLifecycle) {
      this.handlePageLifecycle(new Event("pageshow"));
    }
  }

  hostDisconnected(): void {
    this.updatePageLifecycleListeners(false);
    this.resetQuery();
  }

  private resetSummaries(): void {
    this.summaryPending?.abort();
    this.summaryPending = undefined;
    this.summaryAttempts.clear();
    this.summaryRetries.clear();
  }

  private withActivitySummary(
    row: GatewaySessionRow,
    activitySummary: GatewaySessionRow["activitySummary"],
    readCutoff: number,
  ): GatewaySessionRow {
    const next = this.historyRows.inheritRow({ ...row, activitySummary }, row);
    this.historyRows.observeFields(
      next,
      ["activitySummary"],
      createSessionWriteObservation(++this.historyRevision, null, readCutoff),
      row.agentId,
    );
    return next;
  }

  private resetQuery(): void {
    clearTimeout(this.bucketRollover);
    this.bucketRollover = undefined;
    this.eventRefresh.reset();
    clearTimeout(this.fallbackRefresh);
    this.fallbackRefresh = undefined;
    this.pending?.controller.abort();
    this.pending = undefined;
    this.resetSummaries();
    this.requestState = "idle";
    this.incomplete = false;
    this.error = undefined;
    this.client = null;
    this.queryKey = undefined;
    this.result = undefined;
    this.filters = null;
    this.pendingChanges.length = 0;
    this.changesOverflowed = false;
    this.currentWorkFences.clear();
    this.retirementOverflowed = false;
    this.historyRows.reset();
    this.normalizedLocation = "";
  }

  retrySummary(row: GatewaySessionRow): void {
    if (
      !this.canEnsureSummaries ||
      row.activitySummary?.canEnsure !== true ||
      !this.result?.sessions.includes(row)
    ) {
      return;
    }
    this.summaryAttempts.delete(summaryRowKey(row));
    this.summaryRetries.add(summaryRowKey(row));
    void this.ensureSummaries();
  }

  private needsSummary(row: GatewaySessionRow): boolean {
    const key = summaryRowKey(row);
    return (
      row.activitySummary?.canEnsure === true &&
      (this.summaryRetries.has(key) || row.activitySummary.state === "stale") &&
      this.summaryAttempts.get(key) !== summaryRevision(row)
    );
  }

  private async ensureSummaries(): Promise<void> {
    const client = this.client;
    const queryKey = this.queryKey;
    if (
      !client ||
      !this.result ||
      !this.canEnsureSummaries ||
      this.filters === "current" ||
      this.summaryPending
    ) {
      return;
    }
    if (!this.pageActive) {
      this.eventRefresh.schedule();
      return;
    }
    const visible = new Set(
      this.result.sessions
        .filter((row) => row.activitySummary?.canEnsure === true)
        .map(summaryRowKey),
    );
    for (const key of new Set([...this.summaryAttempts.keys(), ...this.summaryRetries])) {
      if (!visible.has(key)) {
        this.summaryAttempts.delete(key);
        this.summaryRetries.delete(key);
      }
    }
    const candidates = this.result.sessions.filter((row) => this.needsSummary(row));
    if (candidates.length === 0) {
      return;
    }
    const pending = new AbortController();
    this.summaryPending = pending;
    const current = () =>
      this.summaryPending === pending &&
      this.client === client &&
      this.queryKey === queryKey &&
      this.canEnsureSummaries &&
      !pending.signal.aborted;
    try {
      for (let offset = 0; offset < candidates.length && current(); offset += SUMMARY_BATCH_SIZE) {
        const latestRows = new Map<string, GatewaySessionRow>(
          this.result.sessions.map((row) => [summaryRowKey(row), row]),
        );
        const rows: GatewaySessionRow[] = candidates
          .slice(offset, offset + SUMMARY_BATCH_SIZE)
          .flatMap((candidate) => {
            const row = latestRows.get(summaryRowKey(candidate));
            return row && row.sessionId === candidate.sessionId && this.needsSummary(row)
              ? [row]
              : [];
          });
        if (rows.length === 0) {
          continue;
        }
        for (const row of rows) {
          const key = summaryRowKey(row);
          this.summaryAttempts.set(key, summaryRevision(row));
          this.summaryRetries.delete(key);
        }
        const readRevision = ++this.historyRevision;
        try {
          const result = await client.request<{
            sessions: Array<Pick<GatewaySessionRow, "key" | "agentId" | "activitySummary">>;
          }>(
            ACTIVITY_SUMMARY_ENSURE_METHOD,
            {
              sessions: rows.map((row) => ({
                key: row.key,
                ...(row.agentId ? { agentId: row.agentId } : {}),
              })),
            },
            { signal: pending.signal },
          );
          if (!current() || !this.result) {
            return;
          }
          const summaries = new Map(
            result.sessions.map((row) => [summaryRowKey(row), row.activitySummary]),
          );
          this.result = {
            ...this.result,
            sessions: this.result.sessions.map((row) =>
              rows.includes(row) && summaries.has(summaryRowKey(row))
                ? this.withActivitySummary(row, summaries.get(summaryRowKey(row)), readRevision)
                : row,
            ),
          };
        } catch {
          if (!current() || !this.result) {
            return;
          }
          this.result = {
            ...this.result,
            sessions: this.result.sessions.map((row) =>
              rows.includes(row)
                ? this.withActivitySummary(
                    row,
                    { ...row.activitySummary, state: "unavailable" },
                    readRevision,
                  )
                : row,
            ),
          };
        }
        this.host.requestUpdate();
      }
    } finally {
      if (this.summaryPending === pending) {
        this.summaryPending = undefined;
        this.host.requestUpdate();
        void this.ensureSummaries();
      }
    }
  }

  private personLabel(id: string, presence: readonly PresenceViewer[]): string | undefined {
    return (
      this.result?.people?.find((person) => person.identity.id === id)?.label ??
      presence.find((person) => person.identity?.id === id)?.name
    );
  }

  canonicalLocation(
    location: RouteLocation,
    basePath: string,
    presence: readonly PresenceViewer[],
  ): RouteLocation | null {
    if (
      !this.filters ||
      this.filters === "current" ||
      !this.filters.personId ||
      !this.result?.involvingProfileId ||
      this.loading
    ) {
      return null;
    }
    const personId = this.result.involvingProfileId;
    const canonical = canonicalSessionActivityLocation(
      location,
      personId,
      this.personLabel(personId, presence),
      basePath,
    );
    if (!canonical) {
      this.normalizedLocation = "";
      return null;
    }
    const source = `${location.pathname}${location.search}${location.hash}`;
    if (this.normalizedLocation === source) {
      return null;
    }
    // The resolved ID owns the link; replace each stale name once without adding history.
    this.normalizedLocation = source;
    return canonical;
  }

  locationForFilters(
    filters: SessionActivityFilters,
    current: RouteLocation,
    basePath: string,
    presence: readonly PresenceViewer[],
  ) {
    const location = sessionActivityLocation(
      filters,
      basePath,
      filters.personId ? this.personLabel(filters.personId, presence) : undefined,
    );
    const currentId =
      this.result?.involvingProfileId ??
      (this.filters === "current" ? undefined : this.filters?.personId);
    if (filters.personId && filters.personId === currentId) {
      // Filter changes must not broaden an exact legacy bookmark into a shared prefix.
      location.pathname = activityPersonFromPath(current.pathname, basePath)
        ? current.pathname
        : activityPersonLocation(
            filters.personId,
            basePath,
            this.personLabel(filters.personId, presence),
            32,
          ).pathname;
    }
    return location;
  }

  private readonly handlePageLifecycle = (event: Event): void => {
    const leaving = event.type === "pagehide";
    const interrupted = this.pending !== undefined || this.summaryPending !== undefined;
    this.pageActive = !leaving && document.visibilityState !== "hidden";
    if (!this.pageActive) {
      this.resetSummaries();
    }
    this.eventRefresh.setActive(this.pageActive, leaving || interrupted);
  };

  private updatePageLifecycleListeners(add: boolean): void {
    if (!this.observesPageLifecycle) {
      return;
    }
    const method = add ? "addEventListener" : "removeEventListener";
    document[method]("visibilitychange", this.handlePageLifecycle);
    globalThis[method]("pagehide", this.handlePageLifecycle);
    globalThis[method]("pageshow", this.handlePageLifecycle);
  }

  invalidate(payload?: unknown): void {
    if (this.client && this.filters) {
      const changes =
        this.filters === "current"
          ? readCurrentWorkChanges(payload)
          : [readCurrentWorkChange(payload)].filter((change) => change !== null);
      if (changes.length) {
        let requiresRefresh = this.filters !== "current" || !this.pending;
        if (this.result) {
          const next =
            this.filters === "current"
              ? this.reconcileCurrentWork(this.result, changes)
              : !this.filters.personId && !this.filters.query
                ? reconcileSessionActivity(
                    this.result,
                    changes,
                    this.historyRows,
                    ++this.historyRevision,
                  )
                : undefined;
          if (next) {
            this.result = next.result;
            requiresRefresh = next.requiresRefresh;
            this.incomplete ||= this.filters === "current" && requiresRefresh;
            this.host.requestUpdate();
          }
        }
        if (this.pending && this.filters === "current") {
          for (const change of changes) {
            if (change.snapshot) {
              const identity = currentWorkIdentity(change);
              if (
                this.pendingChanges.some(
                  (previous) =>
                    currentWorkIdentity(previous) === identity &&
                    isOlderCurrentWorkChange(change, previous),
                )
              ) {
                continue;
              }
              // Preserve the first receipt and all ordering barriers; only replace a run's tail.
              if (
                sameActiveSnapshot(change, identity) &&
                sameActiveSnapshot(this.pendingChanges.at(-1), identity) &&
                sameActiveSnapshot(this.pendingChanges.at(-2), identity)
              ) {
                this.pendingChanges[this.pendingChanges.length - 1] = change;
                continue;
              }
            }
            // Overlapping completions and replacement starts must retain their arrival order.
            if (this.pendingChanges.length < CURRENT_WORK_CHANGE_LIMIT) {
              this.pendingChanges.push(change);
            } else {
              this.changesOverflowed = true;
            }
          }
        }
        if (!requiresRefresh && !this.incomplete && !this.changesOverflowed) {
          this.fallbackRefresh ??= setTimeout(() => {
            this.fallbackRefresh = undefined;
            this.eventRefresh.schedule();
          }, ACTIVITY_FALLBACK_REFRESH_MS);
          return;
        }
      }
      this.eventRefresh.schedule();
    }
  }

  private reconcileCurrentWork(
    result: SessionsListResult,
    changes: Iterable<CurrentWorkChange>,
    acceptRead = false,
  ) {
    const next = reconcileCurrentWork(
      result,
      changes,
      this.currentWorkFences,
      this.retirementOverflowed,
      acceptRead,
    );
    this.retirementOverflowed = next.retirementOverflowed;
    return next;
  }

  load(
    client: GatewayBrowserClient | null,
    filters: ActivityQuery | null,
    reason: "query" | "refresh" | "retry" = "query",
    canEnsureSummaries = this.canEnsureSummaries,
  ): Promise<void> {
    this.canEnsureSummaries = canEnsureSummaries;
    if (!canEnsureSummaries) {
      this.resetSummaries();
    }
    if (!client || !filters) {
      this.resetQuery();
      this.host.requestUpdate();
      return Promise.resolve();
    }
    const now = new Date();
    const boundaries =
      filters === "current" ? undefined : activityPulseBoundaries(filters.time, now.getTime());
    clearTimeout(this.bucketRollover);
    this.bucketRollover = undefined;
    if (boundaries && typeof setTimeout === "function") {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      const rollover = Math.min(boundaries.at(-1)!, midnight);
      this.bucketRollover = setTimeout(
        () => this.eventRefresh.schedule(),
        rollover - now.getTime() + 1_000,
      );
    }
    const request = {
      rowMode: "compact",
      archived: "all",
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      limit: 100,
      ...(filters === "current"
        ? { activeOnly: true }
        : {
            includePeople: true,
            activityPulseBoundaries: boundaries,
            excludeSubagents: true,
            includeActivitySummary: true,
            sortBy: "activity",
            ...(filters.personId ? { involvingProfileId: filters.personId } : {}),
            ...(filters.query ? { search: filters.query } : {}),
            ...(filters.time === "all"
              ? {}
              : {
                  activeMinutes:
                    filters.time === "24h" ? 1440 : filters.time === "7d" ? 10080 : 43200,
                }),
          }),
    };
    const queryKey = JSON.stringify(request);
    const sameQuery = this.client === client && this.queryKey === queryKey;
    if (sameQuery && this.pending && reason !== "retry") {
      if (reason === "refresh") {
        this.eventRefresh.schedule();
      }
      return this.pending.completion.promise;
    }
    if (reason === "query" && sameQuery) {
      void this.ensureSummaries();
      return Promise.resolve();
    }
    this.pending?.controller.abort();
    this.eventRefresh.absorb();
    clearTimeout(this.fallbackRefresh);
    this.fallbackRefresh = undefined;
    const pending = { controller: new AbortController(), completion: createDeferredCore() };
    this.pending = pending;
    this.client = client;
    this.queryKey = queryKey;
    this.filters = filters;
    this.pendingChanges.length = 0;
    this.changesOverflowed = false;
    this.requestState = reason === "retry" ? "retrying" : "loading";
    this.error = undefined;
    if (!sameQuery) {
      this.currentWorkFences.clear();
      this.retirementOverflowed = false;
      this.historyRows.reset();
      this.resetSummaries();
      this.result = undefined;
      this.incomplete = false;
    }
    const readRevision = ++this.historyRevision;
    this.host.requestUpdate();
    void client
      .request<SessionsListResult>("sessions.list", request, { signal: pending.controller.signal })
      .then((result) => {
        if (this.pending === pending) {
          if (filters === "current") {
            if (!this.changesOverflowed) {
              this.retirementOverflowed = false;
            }
            const next = this.reconcileCurrentWork(result, this.pendingChanges, true);
            this.incomplete = this.changesOverflowed || next.requiresRefresh;
            if (this.incomplete) {
              this.eventRefresh.schedule();
            }
            // Missing membership needs catch-up, but does not invalidate known rows.
            if (!this.changesOverflowed && next.canPublish) {
              this.result = next.result;
            }
          } else {
            const next = reconcileSessionActivityRead(
              result,
              this.result,
              this.historyRows,
              readRevision,
            );
            if (next.requiresRefresh) {
              this.eventRefresh.schedule();
            }
            this.result = next.result;
            void this.ensureSummaries();
          }
        }
      })
      .catch((error: unknown) => {
        if (this.pending === pending && !pending.controller.signal.aborted) {
          if (filters === "current") {
            this.result = undefined;
            this.incomplete = false;
          }
          this.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        if (this.pending === pending) {
          this.pending = undefined;
          this.pendingChanges.length = 0;
          this.requestState = "idle";
          this.host.requestUpdate();
        }
        pending.completion.resolve();
      });
    return pending.completion.promise;
  }
}
