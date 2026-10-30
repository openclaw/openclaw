import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { getSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { throwSettledAggregate } from "./error-graph-internal.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import {
  readOnlyWorkerScope,
  type SqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker-context.js";
import type {
  SqliteAuthProfileReadOptions,
  SqliteReadOnlyOperationOptions,
  SqliteReadOnlyWorkerValue,
} from "./sqlite-readonly-worker-protocol.js";
import type {
  SqliteReadOnlyWorkerLaunch,
  SqliteReadOnlyWorkerSession,
} from "./sqlite-readonly-worker-session-types.js";
import { isSameSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker-session.js";
import { classifyWorkerRequest } from "./sqlite-worker-request-class.js";
import { trackWorkerRequest } from "./worker-request-diagnostics.js";

const log = createSubsystemLogger("state/sqlite");

function trackSqliteRead(options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions) {
  return trackWorkerRequest(
    "sqlite_read",
    classifyWorkerRequest(options.mode === "operation" ? options.command.type : options.mode),
    options.signal,
  );
}

export function createSqliteReadOnlyWorkerPool(
  createSession: (
    launch: SqliteReadOnlyWorkerLaunch & { pooledRead: true },
  ) => SqliteReadOnlyWorkerSession,
) {
  // Process reuse is bounded independently of request scopes. Each slot serializes
  // its requests; cancellation retires only the active child, never another slot.
  const scopedReadWorkers: Array<{
    launch: SqliteReadOnlyWorkerLaunch;
    session?: SqliteReadOnlyWorkerSession;
    tail: Promise<void>;
    queued: number;
    idle?: ReturnType<typeof setTimeout>;
    leased?: { started: boolean };
    quarantined?: { error: unknown };
  }> = [];
  const SCOPED_READ_WORKER_LIMIT = 4;
  const SCOPED_READ_WORKER_IDLE_MS = 60_000;
  const statefulReadWorkers = new WeakMap<
    SqliteReadOnlyWorkerScope,
    (typeof scopedReadWorkers)[number]
  >();
  const readWorkerReleaseWaiters = new Set<() => void>();
  const closingBrokers = new WeakSet<SpawnBrokerHost>();
  const assertBrokerOpen = (launch: SqliteReadOnlyWorkerLaunch) => {
    if (launch.transport.kind === "broker" && closingBrokers.has(launch.transport.owner)) {
      throw new Error("SQLite read-only worker broker is closing");
    }
  };

  async function closeSlot(slot: (typeof scopedReadWorkers)[number]) {
    const worker = slot.session;
    try {
      await worker?.close();
      slot.session = undefined;
    } catch (error) {
      // An unconfirmed native exit still occupies capacity, but must not poison
      // compatible reads that can use another healthy slot.
      slot.quarantined = { error };
      for (const released of readWorkerReleaseWaiters) {
        released();
      }
      throw error;
    }
  }

  async function selectScopedReadWorker(
    options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions,
    launch: SqliteReadOnlyWorkerLaunch,
  ): Promise<(typeof scopedReadWorkers)[number]> {
    assertBrokerOpen(launch);
    const stateful =
      options.mode === "operation" &&
      (options.command.type === "pageCache.begin" || options.command.type === "pageCache.step");
    const scope = readOnlyWorkerScope.getStore();
    if (stateful) {
      if (!scope?.active) {
        throw new Error("Database page-cache warm requires an active read-only worker scope");
      }
      const retained = statefulReadWorkers.get(scope);
      if (retained) {
        if (!isSameSqliteReadOnlyWorkerLaunch(retained.launch, launch)) {
          throw new Error("Database page-cache warm worker launch changed during its scope");
        }
        return retained;
      }
      if (options.command.type === "pageCache.step") {
        throw new Error("Database page-cache warm is no longer active");
      }
    }
    for (;;) {
      assertBrokerOpen(launch);
      options.signal?.throwIfAborted();
      const available = scopedReadWorkers.filter(
        (candidate) => !candidate.leased && !candidate.quarantined,
      );
      let slot = available.find((candidate) =>
        isSameSqliteReadOnlyWorkerLaunch(candidate.launch, launch),
      );
      if (!slot && scopedReadWorkers.length < SCOPED_READ_WORKER_LIMIT) {
        slot = { launch, tail: Promise.resolve(), queued: 0 };
        scopedReadWorkers.push(slot);
      }
      slot ??= available.find((candidate) => candidate.queued === 0 && !candidate.session);
      slot ??= available.reduce<(typeof scopedReadWorkers)[number] | undefined>(
        (best, candidate) => (!best || candidate.queued < best.queued ? candidate : best),
        undefined,
      );
      if (slot) {
        if (stateful && scope) {
          const retained = slot;
          const lease = { started: false };
          retained.leased = lease;
          statefulReadWorkers.set(scope, retained);
          // Stateful iterators span requests; their scope joins native retirement
          // before making the slot available to another launch or caller.
          scope.releaseReadWorker = async () => {
            try {
              if (lease.started) {
                await retained.tail;
                await closeSlot(retained);
              }
            } finally {
              retained.leased = undefined;
              statefulReadWorkers.delete(scope);
              scope.releaseReadWorker = undefined;
              if (
                !retained.quarantined &&
                retained.queued === 0 &&
                retained.session &&
                !retained.session.isRetired()
              ) {
                retained.session.setIdle(true);
                armScopedReadWorkerIdle(retained);
              }
              for (const released of readWorkerReleaseWaiters) {
                released();
              }
            }
          };
        }
        return slot;
      }
      if (scopedReadWorkers.every((candidate) => candidate.quarantined)) {
        throw new AggregateError(
          scopedReadWorkers.map((candidate) => candidate.quarantined?.error),
          "SQLite read-only worker capacity is held by unconfirmed cleanup",
        );
      }
      let released!: () => void;
      const availableWorker = runInDetachedAsyncContext(
        () =>
          new Promise<void>((resolve) => {
            released = resolve;
          }),
      );
      readWorkerReleaseWaiters.add(released);
      try {
        await racePromiseWithAbortSignal(
          availableWorker,
          options.signal,
          (signal) => signal.reason,
        );
      } finally {
        readWorkerReleaseWaiters.delete(released);
      }
    }
  }

  function retireIdleSlot(slot: (typeof scopedReadWorkers)[number]): Promise<void> {
    clearTimeout(slot.idle);
    // Leave the retiring session in the slot until its native close has joined.
    const closing = runInDetachedAsyncContext(() => closeSlot(slot));
    slot.tail = closing.catch(() => {
      log.warn("Idle SQLite read-only worker cleanup failed");
    });
    return closing;
  }

  function armScopedReadWorkerIdle(slot: (typeof scopedReadWorkers)[number]) {
    if (
      slot.launch.transport.kind === "broker" &&
      closingBrokers.has(slot.launch.transport.owner)
    ) {
      void retireIdleSlot(slot);
      return;
    }
    slot.idle = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        void retireIdleSlot(slot);
      }, SCOPED_READ_WORKER_IDLE_MS),
    );
    slot.idle.unref();
  }

  const run = async function runSqliteScopedReadWorker(
    pathname: string,
    options: SqliteAuthProfileReadOptions | SqliteReadOnlyOperationOptions,
    launch: SqliteReadOnlyWorkerLaunch,
    observation = trackSqliteRead(options),
  ): Promise<SqliteReadOnlyWorkerValue> {
    const stateful =
      options.mode === "operation" &&
      (options.command.type === "pageCache.begin" || options.command.type === "pageCache.step");
    let selected: (typeof scopedReadWorkers)[number];
    try {
      selected = await selectScopedReadWorker(options, launch);
      assertBrokerOpen(launch);
    } catch (error) {
      observation.completed();
      throw error;
    }
    clearTimeout(selected.idle);
    selected.queued++;
    const previous = selected.tail;
    const operation = runInDetachedAsyncContext(() =>
      racePromiseWithAbortSignal(previous, options.signal, (signal) => signal.reason),
    )
      .then(async () => {
        options.signal?.throwIfAborted();
        if (selected.quarantined) {
          throw selected.quarantined.error;
        }
        observation.started();
        if (
          selected.leased &&
          options.mode === "operation" &&
          options.command.type === "pageCache.begin"
        ) {
          selected.leased.started = true;
        }
        if (
          !isSameSqliteReadOnlyWorkerLaunch(selected.launch, launch) ||
          selected.session?.isRetired()
        ) {
          await closeSlot(selected);
        }
        options.signal?.throwIfAborted();
        selected.launch = launch;
        const worker = (selected.session ??= createSession({
          ...launch,
          pooledRead: true,
        }));
        worker.setIdle(false);
        try {
          const value = await worker.run(pathname, options);
          options.signal?.throwIfAborted();
          if (
            !stateful &&
            !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources
          ) {
            await closeSlot(selected);
          }
          return value;
        } catch (error) {
          // Confirm native retirement before releasing a failed request's bytes.
          try {
            await closeSlot(selected);
          } catch (cleanupError) {
            throw createSqliteLifecycleAggregateError(
              [error, cleanupError],
              "SQLite read and child cleanup failed",
              error,
            );
          }
          throw error;
        }
      })
      .finally(() => {
        observation.completed();
        selected.queued--;
        if (
          !selected.leased &&
          !selected.quarantined &&
          selected.queued === 0 &&
          selected.session &&
          !selected.session.isRetired()
        ) {
          selected.session?.setIdle(true);
          armScopedReadWorkerIdle(selected);
        }
      });
    selected.tail = runInDetachedAsyncContext(() =>
      Promise.allSettled([previous, operation]).then(() => {}),
    );
    return operation;
  };
  return {
    run,
    async closeBroker(broker: SpawnBrokerHost): Promise<void> {
      closingBrokers.add(broker);
      // In-flight reads retire on settlement; broker shutdown may cancel them first.
      const outcomes = await Promise.allSettled(
        scopedReadWorkers
          .filter(
            (slot) =>
              slot.launch.transport.kind === "broker" &&
              slot.launch.transport.owner === broker &&
              slot.session &&
              slot.queued === 0 &&
              !slot.leased &&
              !slot.quarantined,
          )
          .map(retireIdleSlot),
      );
      throwSettledAggregate(outcomes, "SQLite read-only broker worker cleanup failed");
    },
  };
}
