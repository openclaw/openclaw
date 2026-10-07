import type { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { assertSqliteIntegrityInWorker } from "../infra/sqlite-integrity-worker.js";
import {
  runSqliteIntegrityCheckSync,
  runSqliteIntegrityOperationSync,
  type SqliteIntegrityCheck,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { registerDeferredSqliteWalWriteAdmission } from "../infra/sqlite-wal-write-admission.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertAgentCreationClaimAccess,
  assertAgentCreationClaimAliases,
  assertAgentCreationClaimCurrent,
  captureAgentCreationClaim,
} from "./agent-creation-claim.js";
import { assertAgentDatabaseAdmitted } from "./agent-database-admission.js";
import {
  assertAgentDeletionDatabaseCleanupAccess,
  getAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
  OpenClawAgentDatabaseRegistrationObserver,
  OpenClawAgentDatabaseRepairAdmission,
} from "./openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import type { prepareOpenClawAgentDatabaseWorkerLease } from "./openclaw-agent-db-lease.js";
import {
  agentDatabaseLifecycle as cache,
  retainAgentDatabase,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import {
  assertAgentDatabaseResourceAdmission,
  registerOpenClawAgentDatabaseAsyncResource,
} from "./openclaw-agent-db-resources.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import {
  captureOpenClawAgentDatabaseAliasPublication,
  getOpenClawAgentDatabaseValidationForTransfer,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  observeOpenClawDatabaseMaintenanceResource,
} from "./openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** Denial still invokes run under admission, with a throwing authority check, to permit cleanup. */
export type OpenClawAgentDatabaseWriteAdmission = <T>(
  run: (assertCurrent: () => void, validation?: OpenClawAgentDatabaseValidation) => T | Promise<T>,
) => Promise<T>;

/** Refusal must unwind ownership without entering corruption repair or changing its caller error. */
function assertAgentDatabaseOpenAuthority(
  operation: SqliteIntegrityOperation<OpenClawAgentDatabase>,
  assertCurrent?: () => void,
): void {
  try {
    assertCurrent?.();
  } catch (error) {
    const refusal = new Error("Agent database open authority was refused", { cause: error });
    try {
      operation.throw(refusal);
    } catch (cleanupError) {
      if (cleanupError !== refusal) {
        throw new AggregateError(
          [error, cleanupError],
          `Agent database authority and cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          {
            cause: cleanupError,
          },
        );
      }
    }
    throw error;
  }
}

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
  assertAgentCreationClaimAccess(database, options);
  assertCurrent?.();
}

/** Bind admission drivers to the canonical private database-open generator. */
export function createOpenClawAgentDatabaseAdmissionOwner(
  openSteps: (
    options: OpenClawAgentDatabaseOptions,
    pending?: PendingAgentDatabaseOpen,
    preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
    registrationObserver?: OpenClawAgentDatabaseRegistrationObserver,
    repairAdmission?: OpenClawAgentDatabaseRepairAdmission,
  ) => SqliteIntegrityOperation<OpenClawAgentDatabase>,
) {
  /** Open or return a cached per-agent database after schema and owner validation. */
  function openOpenClawAgentDatabase(
    options: OpenClawAgentDatabaseOptions,
    preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
    registrationObserver?: OpenClawAgentDatabaseRegistrationObserver,
  ): OpenClawAgentDatabase {
    return openAgentDatabase(options, preparedLease, registrationObserver);
  }

  function openAgentDatabase(
    options: OpenClawAgentDatabaseOptions,
    preparedLease?: ReturnType<typeof prepareOpenClawAgentDatabaseWorkerLease>,
    registrationObserver?: OpenClawAgentDatabaseRegistrationObserver,
    repairAdmission?: OpenClawAgentDatabaseRepairAdmission,
  ): OpenClawAgentDatabase {
    const run = () => {
      const steps = openSteps(
        options,
        undefined,
        preparedLease,
        registrationObserver,
        repairAdmission,
      );
      return runSqliteIntegrityOperationSync(
        steps,
        (preparedLease && !isMainThread) || repairAdmission?.assertCurrent
          ? () =>
              assertAgentDatabaseOpenAuthority(steps, () => {
                repairAdmission?.assertCurrent?.();
                if (preparedLease && !isMainThread) {
                  requestSqliteWorkerOperationAdmission({
                    stage: "prepare",
                    facts: { kind: "agent-open-resume", lease: preparedLease.receipt },
                  });
                }
              })
          : undefined,
      );
    };
    const scope = getOpenClawDatabaseMaintenanceScope();
    return scope ? scope.run(run) : run();
  }

  function runOpenClawAgentWriteTransaction<T>(
    operation: (database: OpenClawAgentDatabase) => T,
    options: OpenClawAgentDatabaseOptions,
    transactionOptions: Pick<
      SqliteTransactionOptions,
      "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs" | "diagnosticContext"
    > & { repairAdmission?: OpenClawAgentDatabaseRepairAdmission } = {},
  ): T {
    const { repairAdmission, ...writeOptions } = transactionOptions;
    const database = openAgentDatabase(options, undefined, undefined, repairAdmission);
    const deletionCommit = getAgentDeletionDatabaseCleanup(options)?.withCommit;
    const withCommit = repairAdmission
      ? (commit: () => void) => {
          repairAdmission.assertCurrent?.();
          if (repairAdmission.expectedIdentity) {
            assertOpenClawAgentDatabaseIdentity(database, repairAdmission.expectedIdentity);
          }
          if (deletionCommit) {
            deletionCommit(commit);
          } else {
            commit();
          }
        }
      : deletionCommit;
    const enteredNestedTransaction = database.db.isTransaction;
    return withSqlitePostCommitPublications(database.db, () =>
      runSqliteImmediateTransactionSync(
        database.db,
        () => {
          assertAgentDeletionDatabaseCleanupAccess(database, options);
          assertAgentCreationClaimAccess(database, options);
          const operationResult = operation(database);
          if (!enteredNestedTransaction && !cache.incognito.has(database)) {
            // Permission failure must roll back with the write. Repairing after
            // COMMIT could make callers retry a transaction already durable in SQLite.
            ensureOpenClawAgentDatabasePermissions(database.path, options);
          }
          return operationResult;
        },
        {
          busyTimeoutMs: writeOptions.busyTimeoutMs ?? OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: database.path,
          ...writeOptions,
          operationLabel: writeOptions.operationLabel ?? "agent.write",
          withCommit,
        },
      ),
    );
  }

  /** Released SDK guards may read SQLite; preserve their native open and integrity-resume checkpoints. */
  function withOpenClawAgentDatabaseAsync<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    /** Synchronous live authority for the initiating open and this caller's operation. */
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = () =>
      runAgentDatabaseAsync(inputOptions, operation, assertCurrent, signal, "native");
    const scope = getOpenClawDatabaseMaintenanceScope();
    return scope ? scope.run(run) : run();
  }

  /** Runtime authority runs in worker grants: same-owner row predicates belong in the worker. */
  function withOpenClawAgentDatabaseRuntime<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = () => runAgentDatabaseAsync(inputOptions, operation, assertCurrent, signal);
    const scope = getOpenClawDatabaseMaintenanceScope();
    return scope ? scope.run(run) : run();
  }

  async function runAgentDatabaseAsync<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
    assertCurrent?: () => void,
    signal?: AbortSignal,
    prepared?: "native" | "worker",
  ): Promise<T> {
    signal?.throwIfAborted();
    assertCurrent?.();
    // Admission retains its original path, registration, and permission inputs across awaits.
    const options = {
      ...inputOptions,
      env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
    };
    const agentId = normalizeAgentId(options.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
    options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
    options.path = pathname;
    const cached = cache.databases.get(pathname);
    const schema = getOpenClawAgentDatabaseValidationForTransfer({
      agentId,
      path: pathname,
    })?.schema;
    if (
      !prepared &&
      isMainThread &&
      (!cached?.db.isOpen ||
        (!cache.incognito.has(cached) &&
          (!schema || Atomics.load(new Int32Array(schema.valid), 0) !== 1))) &&
      !cache.pending.has(pathname)
    ) {
      return withWorkerAdmission(options, assertCurrent, signal, (preparation) =>
        runAgentDatabaseAsync(options, operation, assertCurrent, signal, preparation),
      );
    }
    const existing = cache.pending.get(pathname);
    if (existing?.agentId !== undefined && existing.agentId !== agentId) {
      throw new Error(`Agent database ${pathname} is opening for ${existing.agentId}`);
    }
    if (existing?.controller.signal.aborted) {
      return existing.promise.then(
        () => runAgentDatabaseAsync(options, operation, assertCurrent, signal, prepared),
        () => runAgentDatabaseAsync(options, operation, assertCurrent, signal, prepared),
      );
    }
    const pending =
      existing ??
      startOpenClawAgentDatabaseAdmission(
        options,
        agentId,
        pathname,
        assertCurrent,
        prepared === "worker",
      );
    pending.operations += 1;
    const work = racePromiseWithAbortSignal(pending.promise, signal)
      .then((database) => {
        signal?.throwIfAborted();
        assertAgentDatabaseOperationCurrent(database, options, pending, assertCurrent);
        observeOpenClawDatabaseMaintenanceResource(database.db);
        return operation(database);
      })
      .finally(() => {
        // Every registered operation retains the publication borrow through its own
        // settlement, including wrapper/adoption awaits before it reaches the writer.
        pending.operations -= 1;
        if (!pending.operations) {
          // The physical owner survives one stopped waiter, but not the last one.
          if (!pending.releaseBorrow) {
            pending.controller.abort(new Error("Agent database admission has no waiting callers"));
          }
          pending.releaseBorrow?.();
        }
      });
    return work;
  }

  /** Run on a Worker to keep its same-connection integrity check outside the parent writer. */
  function withOpenClawAgentDatabaseAdmission<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    withAdmission: OpenClawAgentDatabaseWriteAdmission,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
  ): Promise<T> {
    const run = () => runAgentDatabaseAdmission(inputOptions, withAdmission, operation);
    const scope = getOpenClawDatabaseMaintenanceScope();
    return scope ? scope.run(() => scope.track(run())) : run();
  }

  async function runAgentDatabaseAdmission<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    withAdmission: OpenClawAgentDatabaseWriteAdmission,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
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
      return withOpenClawAgentDatabaseAdmission(options, withAdmission, operation);
    }
    const admission = createOpenClawAgentDatabaseAdmission(agentId, pathname);
    const { pending } = admission;
    // This caller receives its scoped operation result; lifecycle disposal joins the open promise.
    void pending.promise.catch(() => {});
    pending.operations += 1;
    const steps = openSteps(options, pending);
    let check: SqliteIntegrityCheck | undefined;
    let failure: { error: unknown } | undefined;
    let suspended = false;
    try {
      while (true) {
        const outcome = await withAdmission(async (assertCurrent, validation) => {
          suspended = false;
          assertAgentDatabaseOpenAuthority(steps, () => {
            assertCurrent();
            assertOpenClawAgentDatabaseAdmissionCurrent(options, pending, check?.database);
          });
          pending.validation = validation;
          const step = failure ? steps.throw(failure.error) : steps.next();
          if (!step.done) {
            suspended = true;
            return { done: false as const, check: step.value };
          }
          pending.releaseBorrow = retainAgentDatabase(step.value.db);
          admission.complete(step.value);
          const assertOperationCurrent = () =>
            assertAgentDatabaseOperationCurrent(step.value, options, pending, assertCurrent);
          assertOperationCurrent();
          const flushMaintenance = isMainThread
            ? undefined
            : registerDeferredSqliteWalWriteAdmission(step.value.db);
          flushMaintenance?.(assertOperationCurrent);
          const result = await operation(step.value);
          flushMaintenance?.(assertOperationCurrent);
          return { done: true as const, result };
        });
        if (outcome.done) {
          return outcome.result;
        }
        check = outcome.check;
        failure = undefined;
        try {
          pending.controller.signal.throwIfAborted();
          runSqliteIntegrityCheckSync(check);
        } catch (error) {
          failure = { error };
        }
      }
    } catch (error) {
      const failures = [error];
      if (suspended) {
        const cancellation = new Error(`Agent database admission failed: ${pathname}`, {
          cause: error,
        });
        try {
          // A lost scheduler cannot grant another permit. A generic refusal only
          // unwinds this owner's handle and lease; it cannot enter index repair.
          steps.throw(cancellation);
        } catch (cleanupError) {
          if (cleanupError !== cancellation) {
            failures.push(cleanupError);
          }
        }
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
    assertAgentDatabaseResourceAdmission({ agentId, path: pathname });
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
    assertAgentCreationClaimCurrent(options);
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
    workerPrepared = false,
  ): PendingAgentDatabaseOpen {
    const admission = createOpenClawAgentDatabaseAdmission(agentId, pathname);
    const { pending } = admission;
    pending.workerPrepared = workerPrepared;
    const operation = openSteps(options, pending);
    void (async () => {
      assertAgentDatabaseOpenAuthority(operation, assertCurrent);
      let step = operation.next();
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

  return {
    openOpenClawAgentDatabase,
    runOpenClawAgentWriteTransaction,
    withOpenClawAgentDatabaseAsync,
    withOpenClawAgentDatabaseRuntime,
    withOpenClawAgentDatabaseAdmission,
  };
}

/** The existing executor owns cold admission; the native callback retains the SDK handle contract. */
async function withWorkerAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  assertCurrent: (() => void) | undefined,
  signal: AbortSignal | undefined,
  run: (preparation: "native" | "worker") => Promise<T>,
): Promise<T> {
  const pathname = resolveOpenClawAgentSqlitePath(options);
  assertAgentCreationClaimCurrent(options);
  assertAgentCreationClaimAliases(options);
  const creationClaim = captureAgentCreationClaim(options);
  const identity = readDatabasePathIdentitySync(pathname);
  const agentId = normalizeAgentId(options.agentId);
  let publishAlias =
    identity.canonicalPath !== pathname
      ? captureOpenClawAgentDatabaseAliasPublication({ agentId, path: pathname })
      : undefined;
  const completion = createDeferredCore();
  let revoked = false;
  let releaseExecution: (() => Promise<void>) | undefined;
  const assertAdmission = () => {
    if (revoked) {
      throw new Error("Agent database admission closed during worker preparation");
    }
    assertCurrent?.();
    creationClaim?.assertCurrent();
    signal?.throwIfAborted();
    const current = readDatabasePathIdentitySync(pathname);
    if (
      current.canonicalPath !== identity.canonicalPath ||
      (identity.key.startsWith("file:") &&
        (current.key !== identity.key || current.birthtime !== identity.birthtime))
    ) {
      throw new Error("Agent database changed during worker preparation");
    }
  };
  const resource = {
    agentId,
    path: pathname,
    revoke: () => {
      revoked = true;
    },
    close: () => completion.promise,
  };
  const unregister = registerOpenClawAgentDatabaseAsyncResource(resource, options);
  try {
    const owner = await import("./openclaw-agent-execution.js");
    assertAdmission();
    // Doctor/maintenance, deletion cleanup and process-held incognito retain their local owner.
    if (!owner.supportsOpenClawAgentDatabaseExecution(options)) {
      return await run("native");
    }
    const execution = owner.captureOpenClawAgentDatabaseExecution(
      options,
      identity.key.startsWith("file:")
        ? {
            expectedIdentity: {
              kind: "file",
              physicalIdentity: identity.key.slice("file:".length),
              nativeLocation: identity.canonicalPath,
              birthtime: identity.birthtime,
            },
          }
        : {},
    );
    releaseExecution = () => execution.release();
    const source: Parameters<typeof execution.prepare>[0] = {
      assertCurrent: assertAdmission,
      createAdmission: (binding) => () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertAdmission();
          if (
            publishAlias &&
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            request.facts.kind === "agent-validation-start"
          ) {
            publishAlias = captureOpenClawAgentDatabaseAliasPublication({
              agentId,
              path: pathname,
            });
          }
          if (!grant()) {
            throw new Error("Agent database preparation lost its admission");
          }
        }, binding.attachment),
      }),
    };
    await runOpenClawAgentWorkerWrite(options, () =>
      execution.prepare(source, signal, { readmitSchema: true }),
    );
    assertAdmission();
    publishAlias?.(
      execution.captureGenerationClaim().identity,
      getOpenClawAgentDatabaseValidationForTransfer({ agentId, path: identity.canonicalPath }),
    );
    return await run("worker");
  } finally {
    try {
      await releaseExecution?.();
    } finally {
      unregister();
      completion.resolve();
    }
  }
}
