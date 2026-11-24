import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { monotonicNow } from "../../../../src/shared/monotonic-time.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import {
  isAgentDatabaseInspectionPendingError,
  isAwaitingGatewayFailure,
  resolveGatewayReadRetryDelayMs,
} from "../gateway-availability.ts";
import { createSessionEventRefreshCoordinator } from "./event-refresh-coordinator.ts";
import { appendSessionResults } from "./reconcile.ts";
import {
  coalesceSessionRefresh,
  completeSessionRefreshWaiters,
  isForegroundReplacement,
  isSameSessionListQuery,
  prepareSessionRefreshOptions,
  queuedSessionRefreshCompletion,
  sessionListReadNeedsEventRefresh,
  type ManagedSessionList,
  type ManagedSessionListRefresh,
  type ObservedSessionList,
  type QueuedSessionRefresh,
  type SessionRefreshAttempt,
  type SessionListRead,
  type PrimarySessionListRead,
  type PrimarySessionListPresentation,
} from "./session-list-query.ts";
import type { SessionListRefreshHost } from "./session-refresh-types.ts";
import {
  buildSessionListParams,
  normalizeManagedSessionListQuery,
  requestSessionListWindow,
  sessionListQueryKey,
  sessionListRequestKey,
} from "./session-requests.ts";
import type { createSessionRosterObservations } from "./session-roster-observations.ts";
import type {
  SessionListScope,
  SessionListSnapshot,
  SessionRefreshOptions,
} from "./session-types.ts";

export function getManagedSessionList(
  lists: Map<string, ManagedSessionList>,
  scope: SessionListScope,
  refresh: (entry: ManagedSessionList, isCurrent: () => boolean) => Promise<void>,
): ManagedSessionList {
  const key = sessionListQueryKey(scope);
  const current = lists.get(key);
  if (current) {
    return current;
  }
  const query = normalizeManagedSessionListQuery(scope);
  const entry: ManagedSessionList = {
    key,
    query,
    scope: Object.freeze({ ...scope }),
    retainedLimit: query.limit,
    receivedKeys: new Set(),
    startupRetryAttempt: 0,
    deniedConnectionEpoch: null,
    readGeneration: 0,
    readRevision: 0,
    connectionEpoch: null,
    snapshot: { result: null, agentId: null, loading: false, error: null },
    retainSnapshot: false,
    listeners: new Set(),
    coordinator: createSessionEventRefreshCoordinator({
      active: false,
      refresh: (isCurrent) => refresh(entry, isCurrent),
    }),
    pending: null,
    reads: new Set(),
    queued: null,
  };
  lists.set(key, entry);
  return entry;
}

export function publishManagedList(
  entry: ObservedSessionList,
  snapshot: SessionListSnapshot,
  isCurrent: () => boolean = () => true,
): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    if (!isCurrent() || entry.snapshot !== snapshot) {
      return;
    }
    listener(snapshot);
  }
}

/** Own admitted reads and their successors; selection and membership consume their own receipts. */
export function createSessionManagedListRefresh(
  host: SessionListRefreshHost,
  {
    managedLists,
    open,
    observations,
    nextRevision,
    isPageActive,
    publishPrimary,
    release,
    primary,
  }: {
    managedLists: ReadonlyMap<string, ManagedSessionList>;
    open: (scope: SessionListScope) => ManagedSessionList;
    observations: Pick<
      ReturnType<typeof createSessionRosterObservations>,
      "accept" | "stageObservedRows" | "mergeRows" | "rowRevision"
    >;
    nextRevision: () => number;
    isPageActive: () => boolean;
    publishPrimary: (result: SessionsListResult | null) => void;
    release: (entry: ManagedSessionList) => void;
    primary: {
      prepare: (
        read: SessionListRead,
        options: SessionRefreshOptions,
        bootstrap: boolean,
        isErrorCurrent: (() => boolean) | undefined,
      ) => PrimarySessionListPresentation;
      retirePublication: () => void;
      absorb: () => void;
      retry: (delayMs: number) => void;
      options: (agentId?: string | null) => SessionRefreshOptions;
    };
  },
) {
  let primaryRead: PrimarySessionListRead | null = null;
  let queuedPrimary: QueuedSessionRefresh | null = null;
  let primaryRetryAttempt = 0;
  const readIsCurrent = (read: SessionListRead) =>
    managedLists.get(read.entry.key) === read.entry && host.connection.isCurrent(read.scope);
  const managedIsCurrent = (read: SessionListRead) =>
    readIsCurrent(read) &&
    (!read.params.pageSize ||
      (read.generation === read.entry.readGeneration &&
        isPageActive() &&
        read.entry.listeners.size > 0));

  const acceptManaged = (
    read: SessionListRead,
    response: SessionsListResult,
    result: SessionsListResult | null,
  ) => {
    const entry = read.entry;
    const next = read.managed!.refresh;
    const requestParams = read.params;
    if (
      next.append &&
      response.hasMore &&
      (response.nextOffset ?? (requestParams.offset ?? 0) + response.sessions.length) <=
        (requestParams.offset ?? 0)
    ) {
      throw new Error("Session list pagination did not advance.");
    }
    const previous = entry.snapshot.result;
    const agentId = entry.query.agentId;
    const observed = observations.accept(result, entry.snapshot, host.readState().result, agentId);
    const nextResult =
      observed && next.append && requestParams.offset && previous
        ? appendSessionResults(previous, observed)
        : observed;
    if (
      sessionListReadNeedsEventRefresh(
        previous,
        result,
        nextResult,
        read.revision,
        entry.scope,
        observations.rowRevision,
      )
    ) {
      entry.coordinator.schedule();
    }
    // Server window receipts remain separate from locally filtered/decorated rows.
    const appending = Boolean(next.append && requestParams.offset && previous);
    const receivedKeys = new Set(appending ? entry.receivedKeys : []);
    for (const row of response.sessions) {
      receivedKeys.add(row.key);
    }
    const totalCount =
      response.totalCount ?? (appending ? entry.snapshot.pagination?.totalCount : undefined);
    const pageEnd = (response.offset ?? requestParams.offset ?? 0) + response.sessions.length;
    const hasMore = response.hasMore ?? (totalCount !== undefined && pageEnd < totalCount);
    const pagination = {
      count: receivedKeys.size,
      totalCount,
      hasMore,
      nextOffset: response.nextOffset ?? (hasMore ? pageEnd : null),
    };
    const decorated = host.decorate(nextResult, entry);
    if (decorated) {
      entry.retainedLimit = Math.max(entry.retainedLimit, decorated.sessions.length);
    }
    const notifyObserved = observations.stageObservedRows(
      observed?.sessions ?? [],
      read.scope,
      agentId,
      undefined,
      false,
    );
    entry.receivedKeys = receivedKeys;
    entry.connectionEpoch = read.scope.epoch;
    entry.startupRetryAttempt = 0;
    entry.coordinator.acceptWindowExpiry(read.expiry, next.append);
    const snapshot: SessionListSnapshot = {
      readSucceeded: true,
      pagination,
      result: decorated,
      agentId: agentId ?? null,
      loading: false,
      error: null,
    };
    entry.snapshot = snapshot;
    const current = host.readState();
    const merged = observations.mergeRows(
      current.result,
      decorated?.sessions ?? [],
      current.agentId,
      agentId,
    );
    if (merged !== current.result) {
      publishPrimary(merged);
    }
    if (readIsCurrent(read) && entry.snapshot === snapshot) {
      publishManagedList(entry, snapshot, () => readIsCurrent(read));
    }
    notifyObserved();
  };

  const execute = async (read: SessionListRead) => {
    const entry = read.entry;
    let result: SessionsListResult | null = null;
    let failure: { error: unknown } | undefined;
    const hasDemand = () =>
      read.managed
        ? managedIsCurrent(read)
        : [...read.primary].some((consumer) => consumer.presentation?.isCurrent() !== false);
    try {
      const window = await requestSessionListWindow(
        read.scope.client,
        read.params,
        () => readIsCurrent(read) && hasDemand(),
      );
      const response = window?.result ?? null;
      read.expiry = window?.expiry;
      if (readIsCurrent(read) && (read.managed || hasDemand())) {
        // Settled reads are no longer joinable from synchronous publication listeners.
        entry.reads.delete(read);
        if (read.managed && !managedIsCurrent(read)) {
          publishManagedList(entry, { ...entry.snapshot, loading: false }, () =>
            readIsCurrent(read),
          );
        } else {
          if (!response && read.managed) {
            throw new Error("The session query did not return a result. Try again.");
          }
          result = host.reconcileList(response, read.revision, read.params.agentId);
          if (read.managed && response) {
            acceptManaged(read, response, result);
          }
        }
      }
    } catch (error) {
      failure = { error };
      if (readIsCurrent(read) && read.managed) {
        if (error instanceof GatewayProtocolRequestError && error.gatewayCode === "FORBIDDEN") {
          entry.deniedConnectionEpoch = read.scope.epoch;
        }
        const startupPending = isAgentDatabaseInspectionPendingError(error);
        if (startupPending) {
          entry.coordinator.scheduleRetry(
            resolveGatewayReadRetryDelayMs(error, entry.startupRetryAttempt++),
          );
        } else {
          entry.startupRetryAttempt = 0;
        }
        publishManagedList(
          entry,
          {
            ...entry.snapshot,
            loading: false,
            error: isAwaitingGatewayFailure(error, host.snapshot()) ? null : formatUiError(error),
            readSucceeded: false,
            startupPending,
          },
          () => readIsCurrent(read),
        );
      }
    } finally {
      entry.reads.delete(read);
      read.managed?.finishWindowRead(failure?.error);
      for (const consumer of read.primary) {
        consumer.presentation?.finishWindowRead(failure?.error);
        const current = consumer.presentation?.isCurrent() === true;
        if (current) {
          if (isAgentDatabaseInspectionPendingError(failure?.error)) {
            primary.retry(resolveGatewayReadRetryDelayMs(failure?.error, primaryRetryAttempt++));
          } else {
            primaryRetryAttempt = 0;
          }
        }
        const attempt = consumer.presentation?.accept(result, failure) ?? null;
        if (primaryRead === consumer) {
          primaryRead = null;
        }
        if (consumer.queued) {
          const successor =
            attempt === null && host.connection.isCurrent(read.scope)
              ? queuedSessionRefreshCompletion(queuedPrimary, consumer.options)
              : null;
          completeSessionRefreshWaiters(
            consumer.queued,
            Promise.resolve(attempt),
            Promise.resolve(attempt ?? successor),
            consumer.snapshot,
          );
        }
        consumer.completion.resolve(attempt);
      }
      // Both concrete demand sources advance here, after this attempt's consumers settle.
      const managed = read.managed;
      if (managed) {
        const queued = entry.queued;
        if (readIsCurrent(read) && isPageActive() && queued && !queued.background) {
          entry.queued = null;
          admit(entry, queued, managed.completion);
        } else {
          if (entry.pending === managed.completion.promise) {
            entry.pending = null;
          }
          managed.completion.resolve();
          if (queued?.background && readIsCurrent(read) && isPageActive()) {
            entry.coordinator.schedule();
          }
        }
      }
      release(entry);
      if (!primaryRead && queuedPrimary) {
        const next = queuedPrimary;
        if (next.intent !== "explicit" && !next.foreground) {
          void host.background(next, () => admitPrimary());
        } else {
          void admitPrimary();
        }
      }
    }
  };

  const admit = (
    entry: ManagedSessionList,
    refresh?: ManagedSessionListRefresh,
    completion?: ReturnType<typeof createDeferredCore<void>>,
    consumer?: PrimarySessionListRead,
    bootstrap = false,
    isErrorCurrent?: () => boolean,
  ): SessionListRead | null => {
    const scope = host.connection.capture();
    if (!scope) {
      completion?.resolve();
      consumer?.completion.resolve(null);
      return null;
    }
    const params = consumer
      ? buildSessionListParams(consumer.options)
      : {
          ...entry.query,
          limit: refresh?.append ? entry.query.limit : entry.retainedLimit,
          ...(refresh?.append && refresh.offset !== undefined ? { offset: refresh.offset } : {}),
        };
    // Join only the same shape and freshness interval: a later mutation cannot
    // reconcile its membership or caller outcome from a pre-invalidation read.
    const key = sessionListRequestKey(params);
    let read = [...entry.reads].find(
      (candidate) =>
        candidate.scope.epoch === scope.epoch &&
        candidate.generation === entry.readGeneration &&
        sessionListRequestKey(candidate.params) === key &&
        (!refresh?.invalidated || !candidate.managed) &&
        (!consumer ||
          candidate.managed ||
          [...candidate.primary].some((current) => current.presentation?.isCurrent() === true)),
    );
    const fresh = !read;
    if (!read) {
      read = {
        entry,
        issuedAt: monotonicNow(),
        params,
        scope,
        revision: nextRevision(),
        generation: entry.readGeneration,
        primary: new Set(),
      };
      entry.reads.add(read);
    }
    if (refresh && completion) {
      if (!refresh.append) {
        entry.coordinator.absorb();
      }
      read.managed = {
        refresh,
        completion,
        finishWindowRead: entry.coordinator.beginWindowRead(
          read.issuedAt,
          () => managedIsCurrent(read),
          refresh.append,
        ),
      };
      entry.readRevision = read.revision;
      entry.deniedConnectionEpoch = null;
      publishManagedList(entry, { ...entry.snapshot, loading: true, error: null }, () =>
        readIsCurrent(read),
      );
    }
    if (consumer) {
      read.primary.add(consumer);
      consumer.presentation = primary.prepare(read, consumer.options, bootstrap, isErrorCurrent);
    }
    if (fresh) {
      void execute(read);
    }
    return read;
  };

  const admitPrimary = (
    explicitOptions?: SessionRefreshOptions,
    bootstrap = false,
    isErrorCurrent?: () => boolean,
  ): Promise<SessionRefreshAttempt | null> => {
    if (primaryRead || (!explicitOptions && !queuedPrimary)) {
      return Promise.resolve(null);
    }
    const snapshot = host.snapshot();
    const queued =
      explicitOptions &&
      !isForegroundReplacement(explicitOptions) &&
      typeof queuedPrimary?.intent === "function"
        ? null
        : queuedPrimary;
    const options =
      explicitOptions ??
      (typeof queued!.intent === "function" ? primary.options(queued!.intent()) : queued!.options);
    const acceptedBootstrap = explicitOptions ? bootstrap : (queued?.bootstrap ?? false);
    const acceptedErrorCurrent =
      !explicitOptions &&
      queued &&
      isSameSessionListQuery(
        prepareSessionRefreshOptions(queued.errorOwner.options, snapshot),
        prepareSessionRefreshOptions(options, snapshot),
        false,
      )
        ? queued.errorOwner.isCurrent
        : isErrorCurrent;
    if (queued) {
      queuedPrimary = null;
    }
    if (!options.append) {
      primary.absorb();
    }
    const prepared = prepareSessionRefreshOptions(options, snapshot);
    const consumer: PrimarySessionListRead = {
      options: prepared,
      completion: createDeferredCore(),
      queued,
      snapshot,
    };
    primaryRead = consumer;
    admit(open(prepared), undefined, undefined, consumer, acceptedBootstrap, acceptedErrorCurrent);
    return consumer.completion.promise;
  };
  const refreshPrimary = (
    options: SessionRefreshOptions,
    bootstrap = false,
    isErrorCurrent?: () => boolean,
    intent: QueuedSessionRefresh["intent"] = "explicit",
    foreground = false,
  ): Promise<SessionRefreshAttempt | null> => {
    if (!host.connection.capture()) {
      return Promise.resolve(null);
    }
    if (primaryRead || intent !== "explicit") {
      const completion = createDeferredCore<SessionRefreshAttempt | null>();
      queuedPrimary = coalesceSessionRefresh(
        queuedPrimary,
        {
          options,
          errorOwner: { options, isCurrent: isErrorCurrent },
          intent,
          foreground,
          bootstrap,
          completions: [
            { options, reconcile: intent === "reconcile", complete: completion.resolve },
          ],
        },
        host.snapshot(),
      );
      if (isForegroundReplacement(options) && isForegroundReplacement(queuedPrimary.options)) {
        primary.retirePublication();
      }
      if (!primaryRead) {
        if (queuedPrimary.foreground) {
          void admitPrimary();
        } else {
          void host.background(queuedPrimary, () => admitPrimary());
        }
      }
      return completion.promise;
    }
    const hasOverrides = Object.entries(options).some(
      ([key, value]) => key !== "force" && key !== "backgroundHydrate" && value !== undefined,
    );
    if (host.readState().result && !options.force && !hasOverrides) {
      return Promise.resolve({
        options,
        matchesRequestedQuery: true,
        result: host.readState().result,
        outcome: { status: "refreshed" },
      });
    }
    if (isForegroundReplacement(options)) {
      primary.retirePublication();
    }
    return admitPrimary(options, bootstrap, isErrorCurrent);
  };

  const refreshManaged = (
    entry: ManagedSessionList,
    refresh: ManagedSessionListRefresh,
  ): Promise<void> => {
    const scope = host.connection.capture();
    if (!scope || (refresh.background && entry.deniedConnectionEpoch === scope.epoch)) {
      return Promise.resolve();
    }
    if (entry.pending) {
      if (refresh.append && !entry.snapshot.loading && !entry.queued) {
        entry.queued = refresh;
      }
      if (
        refresh.invalidated &&
        (!refresh.background || !entry.queued || entry.queued.background)
      ) {
        entry.readGeneration += 1;
        entry.queued = refresh;
      }
      return entry.pending;
    }
    if (
      (refresh.background &&
        !refresh.invalidated &&
        !refresh.append &&
        entry.connectionEpoch === scope.epoch) ||
      (refresh.append && !entry.snapshot.result)
    ) {
      return Promise.resolve();
    }
    if (!refresh.append) {
      entry.queued = null;
    }
    const completion = createDeferredCore();
    entry.pending = completion.promise;
    admit(entry, refresh, completion);
    return completion.promise;
  };
  return {
    refresh(
      this: void,
      entry: ManagedSessionList,
      refresh: ManagedSessionListRefresh,
      isCurrent: () => boolean = () => true,
    ): Promise<void> {
      entry.retainSnapshot = true;
      if (!refresh.background || entry.pending) {
        return refreshManaged(entry, refresh);
      }
      if (!entry.queued || (refresh.invalidated && entry.queued.background)) {
        entry.queued = refresh;
      }
      return host.background(entry, async () => {
        if (isCurrent() && managedLists.get(entry.key) === entry && entry.listeners.size > 0) {
          if (!isPageActive()) {
            entry.coordinator.setActive(false, true);
            return;
          }
          const queued = entry.queued ?? refresh;
          entry.queued = null;
          await refreshManaged(entry, queued);
        }
      });
    },
    refreshPrimary,
    get primaryPending() {
      return primaryRead?.completion.promise ?? null;
    },
    replacePrimary() {
      primaryRetryAttempt = 0;
      primary.retirePublication();
      primaryRead = null;
    },
    resetPrimary() {
      primaryRetryAttempt = 0;
      primaryRead = null;
      queuedPrimary?.completions.forEach(({ complete }) => complete(null));
      queuedPrimary = null;
    },
    async refreshEvent(isCurrent: () => boolean) {
      const scope = host.connection.capture();
      for (let request = primaryRead; request && isCurrent(); request = primaryRead) {
        await request.completion.promise;
      }
      if (scope && host.connection.isCurrent(scope) && isCurrent() && !queuedPrimary) {
        if (!isPageActive()) {
          return;
        }
        await admitPrimary(primary.options());
      }
    },
  };
}
