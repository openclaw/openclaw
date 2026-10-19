import type { RouteLocation } from "@openclaw/uirouter";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { activityPersonFromPath, activityPersonLocation } from "../../app-route-paths.ts";
import type { PresenceViewer } from "../../lib/presence-users.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { createSessionEventRefreshCoordinator } from "../../lib/sessions/event-refresh-coordinator.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { createSessionRowProvenance } from "../../lib/sessions/session-row-provenance.ts";
import { activityPulseBoundaries } from "./activity-pulse-window.ts";
import {
  readCurrentWorkChange,
  readCurrentWorkChanges,
  currentWorkIdentity,
  isOlderCurrentWorkChange,
  CURRENT_WORK_CHANGE_LIMIT,
  reconcileCurrentWork,
  type CurrentWorkChange,
} from "./current-work.ts";
import {
  canonicalSessionActivityLocation,
  reconcileSessionActivity,
  reconcileSessionActivityRead,
  sessionActivityLocation,
  type SessionActivityFilters,
} from "./session-activity.ts";

type ActivityQuery = SessionActivityFilters | "current";
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
export function createSessionActivity(notify: () => void) {
  let currentResult: SessionsListResult | undefined;
  let currentError: string | undefined;
  let incomplete = false;
  let requestState: "idle" | "loading" | "retrying" = "idle";
  let currentClient: GatewayBrowserClient | null = null;
  let currentQueryKey: string | undefined;
  let pendingRequest:
    | {
        controller: AbortController;
        completion: ReturnType<typeof createDeferredCore<void>>;
      }
    | undefined;
  let summaryPending: AbortController | undefined;
  const summaryAttempts = new Map<string, string>();
  const summaryRetries = new Set<string>();
  let summariesAllowed = false;
  let currentFilters: ActivityQuery | null = null;
  let bucketRollover: ReturnType<typeof setTimeout> | undefined;
  const pendingChanges: CurrentWorkChange[] = [];
  let changesOverflowed = false;
  const historyRows = createSessionRowProvenance();
  let historyRevision = 0;
  let normalizedLocation = "";
  const observesPageLifecycle =
    typeof document !== "undefined" && typeof globalThis.addEventListener === "function";
  let pageActive = !observesPageLifecycle || document.visibilityState !== "hidden";
  const eventRefresh = createSessionEventRefreshCoordinator({
    active: pageActive,
    refresh: () => load(currentClient, currentFilters, "refresh"),
  });
  function resetSummaries(): void {
    summaryPending?.abort();
    summaryPending = undefined;
    summaryAttempts.clear();
    summaryRetries.clear();
  }

  function applySummaryBatch(
    result: SessionsListResult,
    rows: readonly GatewaySessionRow[],
    summaries: ReadonlyMap<string, GatewaySessionRow["activitySummary"]> | null,
  ): void {
    currentResult = {
      ...result,
      sessions: result.sessions.map((row) => {
        if (!rows.includes(row) || (summaries && !summaries.has(summaryRowKey(row)))) {
          return row;
        }
        const activitySummary = summaries
          ? summaries.get(summaryRowKey(row))
          : { ...row.activitySummary, state: "unavailable" as const };
        const next = historyRows.inheritRow({ ...row, activitySummary }, row);
        return next;
      }),
    };
  }

  function resetQuery(): void {
    clearTimeout(bucketRollover);
    bucketRollover = undefined;
    eventRefresh.reset();
    pendingRequest?.controller.abort();
    pendingRequest = undefined;
    resetSummaries();
    requestState = "idle";
    incomplete = false;
    currentError = undefined;
    currentClient = null;
    currentQueryKey = undefined;
    currentResult = undefined;
    currentFilters = null;
    pendingChanges.length = 0;
    changesOverflowed = false;
    historyRows.reset();
    normalizedLocation = "";
  }

  function retrySummary(row: GatewaySessionRow): void {
    if (
      !summariesAllowed ||
      row.activitySummary?.canEnsure !== true ||
      !currentResult?.sessions.includes(row)
    ) {
      return;
    }
    summaryAttempts.delete(summaryRowKey(row));
    summaryRetries.add(summaryRowKey(row));
    void ensureSummaries();
  }

  function needsSummary(row: GatewaySessionRow): boolean {
    const key = summaryRowKey(row);
    return (
      row.activitySummary?.canEnsure === true &&
      (summaryRetries.has(key) || row.activitySummary.state === "stale") &&
      summaryAttempts.get(key) !== summaryRevision(row)
    );
  }

  async function ensureSummaries(): Promise<void> {
    const client = currentClient;
    const queryKey = currentQueryKey;
    if (
      !client ||
      !currentResult ||
      !summariesAllowed ||
      currentFilters === "current" ||
      summaryPending
    ) {
      return;
    }
    if (!pageActive) {
      eventRefresh.schedule();
      return;
    }
    const visible = new Set(
      currentResult.sessions
        .filter((row) => row.activitySummary?.canEnsure === true)
        .map(summaryRowKey),
    );
    for (const key of new Set([...summaryAttempts.keys(), ...summaryRetries])) {
      if (!visible.has(key)) {
        summaryAttempts.delete(key);
        summaryRetries.delete(key);
      }
    }
    const candidates = currentResult.sessions.filter((row) => needsSummary(row));
    if (candidates.length === 0) {
      return;
    }
    const pending = new AbortController();
    summaryPending = pending;
    const current = () =>
      summaryPending === pending &&
      currentClient === client &&
      currentQueryKey === queryKey &&
      summariesAllowed &&
      !pending.signal.aborted;
    try {
      for (let offset = 0; offset < candidates.length && current(); offset += SUMMARY_BATCH_SIZE) {
        const latestRows = new Map<string, GatewaySessionRow>(
          currentResult.sessions.map((row) => [summaryRowKey(row), row]),
        );
        const rows: GatewaySessionRow[] = candidates
          .slice(offset, offset + SUMMARY_BATCH_SIZE)
          .flatMap((candidate) => {
            const row = latestRows.get(summaryRowKey(candidate));
            return row && row.sessionId === candidate.sessionId && needsSummary(row) ? [row] : [];
          });
        if (rows.length === 0) {
          continue;
        }
        for (const row of rows) {
          const key = summaryRowKey(row);
          summaryAttempts.set(key, summaryRevision(row));
          summaryRetries.delete(key);
        }
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
          if (!current() || !currentResult) {
            return;
          }
          const summaries = new Map(
            result.sessions.map((row) => [summaryRowKey(row), row.activitySummary]),
          );
          applySummaryBatch(currentResult, rows, summaries);
        } catch {
          if (!current() || !currentResult) {
            return;
          }
          applySummaryBatch(currentResult, rows, null);
        }
        notify();
      }
    } finally {
      if (summaryPending === pending) {
        summaryPending = undefined;
        notify();
        void ensureSummaries();
      }
    }
  }

  function personLabel(id: string, presence: readonly PresenceViewer[]): string | undefined {
    return (
      currentResult?.people?.find((person) => person.identity.id === id)?.label ??
      presence.find((person) => person.identity?.id === id)?.name
    );
  }

  function canonicalLocation(
    location: RouteLocation,
    basePath: string,
    presence: readonly PresenceViewer[],
  ): RouteLocation | null {
    if (
      !currentFilters ||
      currentFilters === "current" ||
      !currentFilters.personId ||
      !currentResult?.involvingProfileId ||
      loading()
    ) {
      return null;
    }
    const personId = currentResult.involvingProfileId;
    const canonical = canonicalSessionActivityLocation(
      location,
      personId,
      personLabel(personId, presence),
      basePath,
    );
    if (!canonical) {
      normalizedLocation = "";
      return null;
    }
    const source = `${location.pathname}${location.search}${location.hash}`;
    if (normalizedLocation === source) {
      return null;
    }
    // The resolved ID owns the link; replace each stale name once without adding history.
    normalizedLocation = source;
    return canonical;
  }

  function locationForFilters(
    filters: SessionActivityFilters,
    current: RouteLocation,
    basePath: string,
    presence: readonly PresenceViewer[],
  ) {
    const location = sessionActivityLocation(
      filters,
      basePath,
      filters.personId ? personLabel(filters.personId, presence) : undefined,
    );
    const currentId =
      currentResult?.involvingProfileId ??
      (currentFilters === "current" ? undefined : currentFilters?.personId);
    if (filters.personId && filters.personId === currentId) {
      // Filter changes must not broaden an exact legacy bookmark into a shared prefix.
      location.pathname = activityPersonFromPath(current.pathname, basePath)
        ? current.pathname
        : activityPersonLocation(
            filters.personId,
            basePath,
            personLabel(filters.personId, presence),
            32,
          ).pathname;
    }
    return location;
  }

  const handlePageLifecycle = (event: Event): void => {
    const leaving = event.type === "pagehide";
    const interrupted = pendingRequest !== undefined || summaryPending !== undefined;
    pageActive = !leaving && document.visibilityState !== "hidden";
    if (!pageActive) {
      resetSummaries();
    }
    eventRefresh.setActive(pageActive, leaving || interrupted);
  };

  function invalidate(payload?: unknown): void {
    if (currentClient && currentFilters) {
      const changes =
        currentFilters === "current"
          ? readCurrentWorkChanges(payload)
          : [readCurrentWorkChange(payload)].filter((change) => change !== null);
      if (changes.length) {
        let requiresRefresh = currentFilters !== "current" || !pendingRequest;
        if (currentResult) {
          const next =
            currentFilters === "current"
              ? reconcileCurrentWork(currentResult, changes)
              : !currentFilters.personId && !currentFilters.query
                ? reconcileSessionActivity(currentResult, changes, historyRows, ++historyRevision)
                : undefined;
          if (next) {
            currentResult = next.result;
            requiresRefresh = next.requiresRefresh;
            incomplete ||= currentFilters === "current" && requiresRefresh;
            notify();
          }
        }
        if (pendingRequest && currentFilters === "current") {
          for (const change of changes) {
            if (change.snapshot) {
              const identity = currentWorkIdentity(change);
              if (
                pendingChanges.some(
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
                sameActiveSnapshot(pendingChanges.at(-1), identity) &&
                sameActiveSnapshot(pendingChanges.at(-2), identity)
              ) {
                pendingChanges[pendingChanges.length - 1] = change;
                continue;
              }
            }
            // Overlapping completions and replacement starts must retain their arrival order.
            if (pendingChanges.length < CURRENT_WORK_CHANGE_LIMIT) {
              pendingChanges.push(change);
            } else {
              changesOverflowed = true;
            }
          }
        }
        if (!requiresRefresh && !incomplete && !changesOverflowed) {
          eventRefresh.scheduleFallback();
          return;
        }
      }
      eventRefresh.schedule();
    }
  }

  function load(
    client: GatewayBrowserClient | null,
    filters: ActivityQuery | null,
    reason: "query" | "refresh" | "retry" = "query",
    canEnsureSummaries = summariesAllowed,
  ): Promise<void> {
    summariesAllowed = canEnsureSummaries;
    if (!canEnsureSummaries) {
      resetSummaries();
    }
    if (!client || !filters) {
      resetQuery();
      notify();
      return Promise.resolve();
    }
    const now = new Date();
    const boundaries =
      filters === "current" ? undefined : activityPulseBoundaries(filters.time, now.getTime());
    clearTimeout(bucketRollover);
    bucketRollover = undefined;
    if (boundaries && typeof setTimeout === "function") {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      const rollover = Math.min(boundaries.at(-1)!, midnight);
      bucketRollover = setTimeout(() => eventRefresh.schedule(), rollover - now.getTime() + 1_000);
    }
    const request = {
      source: "activity",
      excludeDock: true,
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
    const sameQuery = currentClient === client && currentQueryKey === queryKey;
    if (sameQuery && pendingRequest && reason !== "retry") {
      if (reason === "refresh") {
        eventRefresh.schedule();
      }
      return pendingRequest.completion.promise;
    }
    if (reason === "query" && sameQuery) {
      void ensureSummaries();
      return Promise.resolve();
    }
    pendingRequest?.controller.abort();
    eventRefresh.absorb();
    const pending = { controller: new AbortController(), completion: createDeferredCore() };
    pendingRequest = pending;
    currentClient = client;
    currentQueryKey = queryKey;
    currentFilters = filters;
    pendingChanges.length = 0;
    changesOverflowed = false;
    requestState = reason === "retry" ? "retrying" : "loading";
    currentError = undefined;
    if (!sameQuery) {
      historyRows.reset();
      resetSummaries();
      currentResult = undefined;
      incomplete = false;
    }
    const readRevision = ++historyRevision;
    notify();
    void client
      .request<SessionsListResult>("sessions.list", request, { signal: pending.controller.signal })
      .then((result) => {
        if (pendingRequest === pending) {
          if (filters === "current") {
            const next = reconcileCurrentWork(result, pendingChanges);
            incomplete = changesOverflowed || next.requiresRefresh;
            if (incomplete) {
              eventRefresh.schedule();
            }
            // Missing membership needs catch-up, but does not invalidate known rows.
            if (!changesOverflowed && next.canPublish) {
              currentResult = next.result;
            }
          } else {
            currentResult = reconcileSessionActivityRead(
              result,
              currentResult,
              historyRows,
              readRevision,
            );
            void ensureSummaries();
          }
        }
      })
      .catch((error: unknown) => {
        if (pendingRequest === pending && !pending.controller.signal.aborted) {
          if (filters === "current") {
            currentResult = undefined;
            incomplete = false;
          }
          currentError = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        if (pendingRequest === pending) {
          pendingRequest = undefined;
          pendingChanges.length = 0;
          requestState = "idle";
          notify();
        }
        pending.completion.resolve();
      });
    return pending.completion.promise;
  }

  const lifecycleStops = observesPageLifecycle
    ? [
        listen(document, "visibilitychange", handlePageLifecycle),
        listen(globalThis, "pagehide", handlePageLifecycle),
        listen(globalThis, "pageshow", handlePageLifecycle),
      ]
    : [];
  function loading() {
    return requestState !== "idle" || incomplete;
  }
  return {
    get result() {
      return currentResult;
    },
    get error() {
      return currentError;
    },
    get incomplete() {
      return incomplete;
    },
    get loading() {
      return loading();
    },
    get retrying() {
      return requestState === "retrying";
    },
    load,
    invalidate,
    retrySummary,
    canonicalLocation,
    locationForFilters,
    dispose() {
      for (const stop of lifecycleStops) {
        stop();
      }
      resetQuery();
    },
  };
}
