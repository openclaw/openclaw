import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "../infra/sqlite-coordinator.js";
import { assertSqliteIntegrityInWorker } from "../infra/sqlite-integrity-worker.js";
import type { SqliteIntegrityOperation } from "../infra/sqlite-integrity.js";
import { registerDeferredSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
import type { acquireStateDatabaseCoordinatorWithWait } from "../infra/state-database-coordinator-acquisition.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator-errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  assertAgentDeletionDatabaseCleanupAccess,
  getAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  assertAgentDatabaseOpenAuthority,
  isAgentIntegrityPreparationChanged,
  prepareAgentIntegrityReadOnly,
  runAgentDatabaseIntegrityOperationSync,
  withPreparedAgentIntegrity,
} from "./openclaw-agent-db-integrity-preparation.js";
import {
  agentDatabaseLifecycle as cache,
  retainAgentDatabase,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** Denial still invokes run under admission, with a throwing authority check, to permit cleanup. */
export type OpenClawAgentDatabaseWriteAdmission = <T>(
  run: (assertCurrent: () => void, validation?: OpenClawAgentDatabaseValidation) => T | Promise<T>,
) => Promise<T>;

function assertAgentDatabaseOperationCurrent(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  pending: PendingAgentDatabaseOpen,
  assertCurrent?: () => void,
): void {
  pending.controller.signal.throwIfAborted();
  assertAgentDatabaseAdmitted(database.agentId, { env: options.env });
  if (cache.databases.get(pending.path) !== database || !database.db.isOpen) {
    throw new Error(`Agent database closed before its admitted operation: ${pending.path}`);
  }
  // Coalesced callers keep their own scope; admission cannot lend its cleanup authority.
  assertAgentDeletionDatabaseCleanupAccess(database, options);
  assertCurrent?.();
}

type LifecyclePreparation = Pick<
  Parameters<typeof acquireStateDatabaseCoordinatorWithWait>[0],
  "deadlineMs" | "signal" | "onWait"
>;

/** Bind both admission drivers to the canonical private database-open generator. */
export function createOpenClawAgentDatabaseAdmissionOwner(
  openSteps: (
    options: OpenClawAgentDatabaseOptions,
    pending: PendingAgentDatabaseOpen,
  ) => SqliteIntegrityOperation<OpenClawAgentDatabase>,
) {
  /** The initiating caller guards its physical open; each coalesced caller guards its own operation. */
  function withOpenClawAgentDatabaseAsync<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    /** Synchronous live authority for the initiating open and this caller's operation. */
    assertCurrent?: () => void,
    lifecyclePreparation?: LifecyclePreparation,
  ): Promise<T> {
    const run = () =>
      runAgentDatabaseAsync(inputOptions, operation, assertCurrent, lifecyclePreparation);
    const scope = getOpenClawDatabaseMaintenanceScope();
    return scope ? scope.run(run) : run();
  }

  function runAgentDatabaseAsync<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    assertCurrent?: () => void,
    lifecyclePreparation?: LifecyclePreparation,
  ): Promise<T> {
    try {
      assertCurrent?.();
    } catch (error) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Caller assertions retain their original thrown value.
      return Promise.reject(error);
    }
    // Admission retains its original path, registration, and permission inputs across awaits.
    const options = {
      ...inputOptions,
      env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
    };
    const agentId = normalizeAgentId(options.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
    const existing = cache.pending.get(pathname);
    if (existing?.agentId !== undefined && existing.agentId !== agentId) {
      return Promise.reject(
        new Error(`Agent database ${pathname} is opening for ${existing.agentId}`),
      );
    }
    if (existing?.controller.signal.aborted) {
      return existing.promise.then(
        () =>
          withOpenClawAgentDatabaseAsync(options, operation, assertCurrent, lifecyclePreparation),
        () =>
          withOpenClawAgentDatabaseAsync(options, operation, assertCurrent, lifecyclePreparation),
      );
    }
    const pending =
      existing ??
      startOpenClawAgentDatabaseAdmission(
        options,
        agentId,
        pathname,
        assertCurrent,
        lifecyclePreparation,
      );
    pending.operations += 1;
    if (pending.lifecyclePrepared) {
      pending.lifecycleDeadlineMs = Math.max(
        pending.lifecycleDeadlineMs ?? 0,
        lifecyclePreparation?.deadlineMs ?? performance.now() + OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      );
    }
    const waiter = lifecyclePreparation ? new AbortController() : undefined;
    const signal = lifecyclePreparation?.signal
      ? AbortSignal.any([lifecyclePreparation.signal, waiter!.signal])
      : waiter?.signal;
    const deadline =
      lifecyclePreparation && pending.lifecyclePrepared && waiter
        ? setTimeout(
            () => waiter.abort(new StateDatabaseCoordinatorContentionError("state-lifecycle")),
            Math.max(0, lifecyclePreparation.deadlineMs - performance.now()),
          )
        : undefined;
    const notice =
      lifecyclePreparation?.onWait && pending.lifecyclePrepared
        ? setTimeout(() => {
            if (!signal?.aborted) {
              lifecyclePreparation.onWait?.();
            }
          }, 1_000)
        : undefined;
    void pending.lifecyclePrepared?.then(() => {
      clearTimeout(deadline);
      clearTimeout(notice);
    });
    const work = racePromiseWithAbortSignal(pending.promise, signal)
      .catch((error: unknown) => {
        // This waiter owns the typed acquisition deadline; an ordinary caller
        // abort must keep its own cancellation rather than become a busy warning.
        if (waiter?.signal.aborted && !lifecyclePreparation?.signal?.aborted) {
          throw waiter.signal.reason;
        }
        throw error;
      })
      .then((database) => {
        assertAgentDatabaseOperationCurrent(database, options, pending, assertCurrent);
        observeOpenClawDatabaseMaintenanceResource(database.db);
        return operation(database);
      })
      .finally(() => {
        // Every registered operation retains the publication borrow through its own
        // settlement, including wrapper/adoption awaits before it reaches the writer.
        clearTimeout(deadline);
        clearTimeout(notice);
        pending.operations -= 1;
        if (!pending.operations) {
          // The physical owner survives one stopped waiter, but not the last one.
          if (pending.lifecyclePrepared && !pending.releaseBorrow) {
            pending.controller.abort(new Error("Agent database admission has no waiting callers"));
          }
          pending.releaseBorrow?.();
        }
      });
    return work;
  }

  /** Runtime mutation Workers prepare their retained reader before requesting the writer. */
  function withOpenClawAgentDatabaseAdmission<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    withAdmission: OpenClawAgentDatabaseWriteAdmission,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    preparationValidation?: OpenClawAgentDatabaseValidation,
  ): Promise<T> {
    const run = () =>
      runAgentDatabaseAdmission(inputOptions, withAdmission, operation, preparationValidation);
    const scope = getOpenClawDatabaseMaintenanceScope();
    return scope ? scope.run(() => scope.track(run())) : run();
  }

  async function runAgentDatabaseAdmission<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    withAdmission: OpenClawAgentDatabaseWriteAdmission,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    preparationValidation?: OpenClawAgentDatabaseValidation,
  ): Promise<T> {
    const options = {
      ...inputOptions,
      env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
    };
    const agentId = normalizeAgentId(options.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
    const existing = cache.pending.get(pathname);
    if (existing) {
      if (existing.agentId !== agentId) {
        throw new Error(`Agent database ${pathname} is opening for ${existing.agentId}`);
      }
      try {
        await existing.promise;
      } catch (error) {
        if (!existing.controller.signal.aborted) {
          throw error;
        }
      }
      return withOpenClawAgentDatabaseAdmission(
        options,
        withAdmission,
        operation,
        preparationValidation,
      );
    }
    const admission = createOpenClawAgentDatabaseAdmission(agentId, pathname);
    const { pending } = admission;
    // This caller receives its scoped operation result; lifecycle disposal joins the open promise.
    void pending.promise.catch(() => {});
    pending.operations += 1;
    let preparation: ReturnType<typeof prepareAgentIntegrityReadOnly>;
    const closePreparation = () => {
      const captured = preparation;
      preparation = undefined;
      captured?.close();
    };
    try {
      while (true) {
        const cached = cache.databases.get(pathname);
        if (!isMainThread && (!cached?.db.isOpen || cache.failures.has(pathname))) {
          preparation = prepareAgentIntegrityReadOnly(
            options,
            () => assertOpenClawAgentDatabaseAdmissionCurrent(options, pending),
            preparationValidation,
          );
        }
        const outcome = await withAdmission(async (assertCurrent, validation) => {
          const assertAdmittedCurrent = (database?: DatabaseSync) => {
            try {
              assertCurrent();
              assertOpenClawAgentDatabaseAdmissionCurrent(options, pending, database);
            } catch (error) {
              throw new Error(error instanceof Error ? error.message : String(error), {
                cause: error,
              });
            }
          };
          assertAdmittedCurrent();
          try {
            preparation?.assertCurrent();
          } catch (error) {
            if (!isAgentIntegrityPreparationChanged(error)) {
              throw error;
            }
            // No generator step or write-capable open has started; prepare again outside FIFO.
            return { done: false as const, error };
          }
          pending.validation = validation;
          const database = withPreparedAgentIntegrity(preparation, () =>
            runAgentDatabaseIntegrityOperationSync(
              openSteps(options, pending),
              assertAdmittedCurrent,
            ),
          );
          // Canonical repairs and subsequent checks retain this same write reservation.
          closePreparation();
          pending.releaseBorrow = retainAgentDatabase(database.db);
          admission.complete(database);
          const assertOperationCurrent = () =>
            assertAgentDatabaseOperationCurrent(database, options, pending, assertCurrent);
          assertOperationCurrent();
          const flushMaintenance = isMainThread
            ? undefined
            : registerDeferredSqliteWalWriteAdmission(database.db);
          flushMaintenance?.(assertOperationCurrent);
          const result = await operation(database);
          flushMaintenance?.(assertOperationCurrent);
          return { done: true as const, result };
        });
        if (outcome.done) {
          return outcome.result;
        }
        try {
          closePreparation();
        } catch (cleanupError) {
          throw createSqliteLifecycleAggregateError(
            [outcome.error, cleanupError],
            "Stale agent preparation and cleanup failed",
            outcome.error,
          );
        }
      }
    } catch (error) {
      const failures = [error];
      try {
        closePreparation();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      const terminalFailure =
        failures.length === 1
          ? error
          : new AggregateError(failures, "Agent database admission and cleanup failed", {
              cause: error,
            });
      admission.fail(terminalFailure);
      throw terminalFailure;
    } finally {
      pending.operations -= 1;
      if (!pending.operations) {
        pending.releaseBorrow?.();
      }
    }
  }

  function createOpenClawAgentDatabaseAdmission(agentId: string, pathname: string) {
    const completion = createDeferredCore<OpenClawAgentDatabase>();
    const pending: PendingAgentDatabaseOpen = {
      agentId,
      path: pathname,
      controller: new AbortController(),
      promise: completion.promise,
      operations: 0,
    };
    cache.pending.set(pathname, pending);
    cache.activePending.add(pending);
    const retire = () => {
      if (cache.pending.get(pathname) === pending) {
        cache.pending.delete(pathname);
      }
      cache.activePending.delete(pending);
    };
    return {
      pending,
      complete: (database: OpenClawAgentDatabase) => {
        retire();
        if (
          pending.controller.signal.aborted ||
          cache.databases.get(pathname) !== database ||
          !database.db.isOpen
        ) {
          const error =
            pending.controller.signal.reason ??
            new Error(`Agent database closed before admission completed: ${pathname}`);
          completion.reject(error);
          throw error;
        }
        completion.resolve(database);
      },
      fail: (error: unknown) => {
        retire();
        completion.reject(error);
      },
    };
  }

  function assertOpenClawAgentDatabaseAdmissionCurrent(
    options: OpenClawAgentDatabaseOptions,
    pending: PendingAgentDatabaseOpen,
    database?: DatabaseSync,
  ): void {
    const pathname = pending.path;
    pending.controller.signal.throwIfAborted();
    assertAgentDatabaseAdmitted(pending.agentId, { env: options.env });
    if (cache.pending.get(pathname) !== pending) {
      throw new Error(`Agent database open was replaced: ${pathname}`);
    }
    // Cleanup may end during the native check; reject before schema repair can resume.
    getAgentDeletionDatabaseCleanup(options)?.assertCurrent();
    pending.assertHeld?.();
    if (database) {
      assertSupportedAgentSchemaVersion(database, pathname);
      assertExistingAgentSchemaOwner(
        readExistingAgentSchemaMeta(database),
        pending.agentId,
        pathname,
      );
    }
  }

  function startOpenClawAgentDatabaseAdmission(
    options: OpenClawAgentDatabaseOptions,
    agentId: string,
    pathname: string,
    assertCurrent?: () => void,
    lifecyclePreparation?: LifecyclePreparation,
  ): PendingAgentDatabaseOpen {
    const admission = createOpenClawAgentDatabaseAdmission(agentId, pathname);
    const { pending } = admission;
    const operation = openSteps(options, pending);
    const prepared = lifecyclePreparation ? createDeferredCore() : undefined;
    pending.lifecyclePrepared = prepared?.promise;
    void (async () => {
      assertAgentDatabaseOpenAuthority(operation, assertCurrent);
      let step: ReturnType<typeof operation.next>;
      try {
        if (lifecyclePreparation) {
          const [
            { acquireStateDatabaseCoordinatorWithWait },
            { captureOpenClawStateWorkerContext },
          ] = await Promise.all([
            import("../infra/state-database-coordinator-acquisition.js"),
            import("./openclaw-state-worker-context.js"),
          ]);
          const context = captureOpenClawStateWorkerContext({ env: options.env });
          const assertOpening = () => {
            assertOpenClawAgentDatabaseAdmissionCurrent(options, pending);
            context.admission.assertCurrent();
            assertCurrent?.();
          };
          const coordinator = await acquireStateDatabaseCoordinatorWithWait({
            get deadlineMs() {
              return pending.lifecycleDeadlineMs ?? 0;
            },
            operation: "session-admission",
            databasePath: context.admission.databasePath,
            runtime: context.coordinatorRuntime,
            signal: pending.controller.signal,
            assertCurrent: assertOpening,
          });
          // The canonical generator retains the native lease. Release coordinator
          // custody at its integrity yield, before any awaited scan or caller runs.
          step = runWithSqliteCoordinator(coordinator, "agent database admission", () => {
            assertOpening();
            prepared?.resolve();
            return operation.next();
          });
        } else {
          step = operation.next();
        }
      } catch (error) {
        // A release failure can follow a successful yield. Unwind that exact
        // suspended native owner; no caller claim or operation has been published.
        assertAgentDatabaseOpenAuthority(operation, () => {
          throw error;
        });
        throw error;
      } finally {
        prepared?.resolve();
      }
      while (!step.done) {
        const database = step.value.database;
        let failure: unknown;
        let failed = false;
        try {
          await assertSqliteIntegrityInWorker(
            pathname,
            OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            pending.controller.signal,
            undefined,
            step.value.timing,
          );
        } catch (error) {
          failure = error;
          failed = true;
        }
        // Throwing an integrity verdict into the generator can repair indexes too.
        assertAgentDatabaseOpenAuthority(operation, () => {
          assertOpenClawAgentDatabaseAdmissionCurrent(options, pending, database);
          assertCurrent?.();
        });
        // Resuming, or throwing into, the same owner preserves repair and unwind policy.
        step = failed ? operation.throw(failure) : operation.next();
      }
      // A peer may publish before promise consumers run. Their operation owner,
      // not promise scheduling depth, releases this exact connection borrow.
      pending.releaseBorrow = retainAgentDatabase(step.value.db);
      return step.value;
    })()
      .then(admission.complete, admission.fail)
      .catch(admission.fail);
    return pending;
  }

  return { withOpenClawAgentDatabaseAsync, withOpenClawAgentDatabaseAdmission };
}
