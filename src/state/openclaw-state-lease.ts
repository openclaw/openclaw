// Host-owned SQLite leases serialize trusted work across processes.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "./openclaw-state-db-async-lifecycle.js";
import { acquireOpenClawStateLease } from "./openclaw-state-lease-acquisition.js";
import { createOpenClawStateLeaseCleanup } from "./openclaw-state-lease-cleanup.js";
import type {
  OpenClawStateLeaseContext,
  OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease-context.js";
import {
  createOpenClawStateLeaseError as leaseError,
  createOpenClawStateLeaseAbortError as abortError,
  OpenClawStateLeaseError,
} from "./openclaw-state-lease-error.js";
import { createOpenClawStateLeaseExclusion } from "./openclaw-state-lease-exclusion.js";
import { leaseHeartbeatState } from "./openclaw-state-lease-heartbeat-shared.js";
import {
  startOpenClawStateLeaseHeartbeat,
  type startOpenClawStateLeaseTimer,
  type LeaseHeartbeatCleanup,
} from "./openclaw-state-lease-heartbeat.js";
import {
  validateOpenClawStateLeaseOptions,
  type OpenClawStateLeaseOptions,
  type OpenClawStateLeaseInvocation as LeaseInvocation,
} from "./openclaw-state-lease-options.js";
import { registerProcessExitLeaseCleanup } from "./openclaw-state-lease-process-exit.js";
import {
  isOpenClawStateLeaseWriteContention as isLeaseWriteContention,
  prepareLeaseDatabase,
  readLeaseDatabase,
  resolveLeaseDatabasePath,
  acquireLease,
  renewOpenClawStateLease as renew,
  assertOpenClawStateLeaseOwnedInDatabase as assertLeaseOwnedInDatabase,
  verifyOpenClawStateLeaseOwnership as verifyLeaseOwnership,
  releaseOpenClawStateLease as release,
  releaseOpenClawStateLeaseBestEffort as releaseBestEffort,
  type OpenClawStateLeaseOwnerIdentity as LeaseIdentity,
} from "./openclaw-state-lease-storage.js";
import { createOpenClawStateLeaseWorkerOwner } from "./openclaw-state-lease-worker-owner.js";
import { createOpenClawStateLeaseWorkerStorage } from "./openclaw-state-lease-worker-storage.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

export type {
  OpenClawStateLeaseContext,
  OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease-context.js";
export { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";

function invalidInput(message: string): OpenClawStateLeaseError {
  return leaseError("OPENCLAW_STATE_LEASE_INVALID_INPUT", message);
}

/** Run one trusted operation under a host-owned SQLite lease. */
export async function withOpenClawStateLease<T>(
  options: OpenClawStateLeaseOptions,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  return runStateLeaseOwner({ kind: "native", options, run });
}

/**
 * Keep SQLite work in owned workers. The callback must not await closing its
 * own state database: canonical close waits for this complete lease operation.
 * Renewal uses the parent timer unless an independent worker is requested.
 */
export async function withOpenClawStateLeaseAsync<T>(
  options: Omit<OpenClawStateLeaseOptions, "database" | "prepareDatabase">,
  context: OpenClawStateWorkerContext,
  run: (lease: OpenClawStateAsyncLeaseContext) => Promise<T>,
): Promise<T> {
  return runStateLeaseOwner({
    kind: "worker",
    options: {
      ...options,
      database: {
        scope: "shared",
        options: { path: context.admission.databasePath, env: context.environment },
      },
    },
    context,
    run,
  });
}

function runStateLeaseOwner<T>(invocation: LeaseInvocation<T>): Promise<T> {
  const maintenance =
    invocation.kind === "worker"
      ? invocation.context.maintenanceScope
      : getOpenClawDatabaseMaintenanceScope();
  const run = () => runStateLeaseOwnerInScope(invocation, maintenance);
  return maintenance ? maintenance.run(() => maintenance.track(run())) : run();
}

async function runStateLeaseOwnerInScope<T>(
  invocation: LeaseInvocation<T>,
  maintenance: OpenClawDatabaseMaintenanceScope | undefined,
): Promise<T> {
  const validated = validateOpenClawStateLeaseOptions(invocation.options);
  const owner = randomUUID();
  const identity: LeaseIdentity = {
    scope: validated.scope,
    key: validated.key,
    owner,
    leaseLabel: validated.leaseLabel,
  };
  let closed = false;
  let disposed = false;
  let phase: "acquiring" | "owned" | "draining" = "acquiring";
  let heartbeatStopped = true;
  let fileExclusion: ReturnType<typeof createOpenClawStateLeaseExclusion> | undefined;
  const heartbeatCleanups = new Set<LeaseHeartbeatCleanup>();
  let workerHeartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;
  let startingHeartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;
  let timerHeartbeat: ReturnType<typeof startOpenClawStateLeaseTimer> | undefined;
  let asyncOwnership: { verify(): Promise<number>; renew(): Promise<number> } | undefined;
  const expiryObservation =
    invocation.kind === "worker"
      ? new BigInt64Array(
          new SharedArrayBuffer(
            (leaseHeartbeatState.startupPhase + 1) * BigInt64Array.BYTES_PER_ELEMENT,
          ),
        )
      : undefined;
  const workerStorage =
    invocation.kind === "worker"
      ? createOpenClawStateLeaseWorkerStorage(invocation.context)
      : undefined;
  let workerOperations: ReturnType<typeof createOpenClawStateLeaseWorkerOwner> | undefined;
  let assertAcquisitionCurrent: (() => void) | undefined;
  let confirmedExpiresAt: number | undefined;
  const leaseLost = new AbortController();
  const operationSignal = validated.signal
    ? AbortSignal.any([validated.signal, leaseLost.signal])
    : leaseLost.signal;
  const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(validated.leaseMs / 3)));
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abortLost = (cause?: unknown) => {
    if (!leaseLost.signal.aborted) {
      leaseLost.abort(
        cause instanceof OpenClawStateLeaseError
          ? cause
          : leaseError(
              "OPENCLAW_STATE_LEASE_LOST",
              `${validated.leaseLabel} ${validated.scope}/${validated.key} was lost`,
              cause,
            ),
      );
    }
  };
  const assertActive = () => {
    if (leaseLost.signal.aborted) {
      throw leaseLost.signal.reason;
    }
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "operation", validated.leaseLabel);
    }
    if (closed || timerHeartbeat?.isExpired()) {
      abortLost();
      throw leaseLost.signal.reason;
    }
  };
  function stopWorker() {
    void workerHeartbeat?.stop().catch(abortLost);
    void startingHeartbeat?.stop().catch(abortLost);
  }
  function stopTimer() {
    void timerHeartbeat?.stopRenewal();
  }
  let unregisterProcessExitCleanup: (() => void) | undefined;
  if (workerStorage) {
    workerOperations = createOpenClawStateLeaseWorkerOwner({
      identity: { scope: identity.scope, key: identity.key, owner: identity.owner },
      databasePath: workerStorage.path,
      expiryObservation: expiryObservation?.buffer,
      assertCurrent(purpose) {
        if (disposed) {
          throw leaseError("OPENCLAW_STATE_LEASE_LOST", "State lease owner is closed");
        }
        if (purpose === "release") {
          if (phase !== "draining" || !heartbeatStopped) {
            throw new Error("State lease cleanup has not joined its heartbeat");
          }
          return;
        }
        workerStorage.assertCurrent();
        if (purpose === "acquire") {
          if (leaseLost.signal.aborted) {
            throw leaseLost.signal.reason;
          }
          if (phase !== "acquiring") {
            throw new Error("State lease acquisition has already settled");
          }
          assertAcquisitionCurrent?.();
          return;
        }
        assertActive();
        if (phase !== "owned") {
          throw new Error("State lease no longer admits operations");
        }
        workerHeartbeat?.assertRunning();
      },
    });
  }
  const releaseOwned = async () => {
    phase = "draining";
    const params = {
      ...identity,
      database: validated.database,
      operationLabel: validated.operationLabel,
    };
    const execution = workerOperations;
    await releaseBestEffort(
      params,
      workerStorage && execution
        ? () => workerStorage.release(execution, validated.operationLabel)
        : undefined,
    );
    await execution?.settle();
  };
  workerStorage?.assertCurrent();
  const cleanup = createOpenClawStateLeaseCleanup({
    maintenanceScope: maintenance,
    context: invocation.kind === "worker" ? invocation.context : undefined,
    workerOwner: () => workerOperations,
    revoke() {
      closed = true;
      abortLost(new Error("State lease resource owner is closing"));
      stopWorker();
    },
    async finish() {
      phase = "draining";
      closed = true;
      await timerHeartbeat?.close();
      await workerOperations?.settle();
      const failures: unknown[] = [];
      for (const heartbeatCleanup of heartbeatCleanups) {
        try {
          await heartbeatCleanup.close();
          heartbeatCleanups.delete(heartbeatCleanup);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw createSqliteLifecycleAggregateError(
          failures,
          "State lease heartbeat cleanup failed",
          failures[0],
        );
      }
      workerHeartbeat = undefined;
      heartbeatStopped = true;
      if (
        confirmedExpiresAt !== undefined &&
        (fileExclusion?.canRelease() ?? true) &&
        (!workerOperations || workerOperations.canRelease())
      ) {
        await releaseOwned();
      }
      await workerOperations?.settle();
      disposed = true;
      workerOperations?.close();
    },
  });
  const run = async (): Promise<T> => {
    try {
      await acquireOpenClawStateLease({
        label: `${validated.leaseLabel} ${validated.scope}/${validated.key}`,
        waitMs: validated.waitMs,
        signal: validated.signal,
        assertCurrent() {
          if (leaseLost.signal.aborted) {
            throw leaseLost.signal.reason;
          }
        },
        prepare:
          invocation.kind === "native" &&
          validated.prepareDatabase &&
          validated.waitMs > 0 &&
          validated.database.schemaPolicy !== "existing"
            ? () => prepareLeaseDatabase(validated.database)
            : undefined,
        acquire(assertCurrent, signal) {
          assertAcquisitionCurrent = assertCurrent;
          return workerStorage && workerOperations
            ? workerStorage.acquire(
                workerOperations,
                validated.leaseMs,
                validated.operationLabel,
                signal,
                expiryObservation !== undefined,
              )
            : acquireLease(
                validated.database,
                { identity, operationLabel: validated.operationLabel, leaseMs: validated.leaseMs },
                assertCurrent,
                signal,
              );
        },
        acquired(expiresAt) {
          confirmedExpiresAt = expiresAt;
          if (validated.signal?.aborted) {
            throw abortError(validated.signal, "operation", validated.leaseLabel);
          }
        },
      });
    } catch (error) {
      workerOperations?.rethrowIfUncertain(error, undefined);
      throw error;
    }
    if (confirmedExpiresAt === undefined) {
      throw new Error("State lease acquisition did not record its owner");
    }
    const acquiredAt = confirmedExpiresAt - validated.leaseMs;
    phase = "owned";
    // Legacy native callers release synchronously on process.exit(). Async callers
    // must unwind their scope before exiting so native worker teardown can join.
    unregisterProcessExitCleanup = registerProcessExitLeaseCleanup(() => {
      closed = true;
      workerOperations?.close();
      workerHeartbeat?.close();
      startingHeartbeat?.close();
      if (
        workerStorage ||
        !fileExclusion?.canRelease() ||
        (workerOperations && !workerOperations.canRelease())
      ) {
        return;
      }
      release({
        ...identity,
        database: validated.database,
        operationLabel: validated.operationLabel,
      });
    });
    const scheduleExpiry = () => {
      if (expiryTimer) {
        clearTimeout(expiryTimer);
      }
      expiryTimer = setTimeout(
        () => abortLost(),
        Math.max(1, (confirmedExpiresAt ?? Date.now()) - Date.now()),
      );
      expiryTimer.unref?.();
    };
    const renewAndSchedule = () => {
      confirmedExpiresAt = renew({
        ...identity,
        database: validated.database,
        operationLabel: validated.operationLabel,
        leaseMs: validated.leaseMs,
      });
      scheduleExpiry();
    };
    const renewOperation = () => {
      assertActive();
      if (startingHeartbeat) {
        throw new Error("state lease heartbeat is restarting");
      }
      if (fileExclusion?.assertIfExcluded()) {
        return;
      }
      if (workerHeartbeat) {
        assertOperationOwned();
      } else {
        renewAndSchedule();
      }
    };
    const renewFromTimer = () => {
      try {
        renewAndSchedule();
      } catch (error) {
        if (
          error instanceof OpenClawStateLeaseError &&
          error.code === "OPENCLAW_STATE_LEASE_LOST"
        ) {
          abortLost(error);
        } else if (confirmedExpiresAt !== undefined && Date.now() >= confirmedExpiresAt) {
          abortLost(error);
        }
      }
    };

    const assertOperationOwned = (transaction?: DatabaseSync) => {
      assertActive();
      if (startingHeartbeat) {
        throw new Error("state lease heartbeat is restarting");
      }
      if (fileExclusion?.assertIfExcluded()) {
        if (transaction) {
          throw new Error("a file-excluded lease cannot authorize a write transaction");
        }
        return;
      }
      assertDatabaseOwner(transaction);
    };
    // Internal confirmation after restart does not enter public capture admission.
    // It still reads the exact durable owner and checks the ready worker's liveness.
    const assertDatabaseOwner = (transaction?: DatabaseSync) => {
      assertActive();
      const params = { ...identity, database: validated.database, transaction };
      const expiresAt = verifyLeaseOwnership(params);
      if (workerHeartbeat) {
        try {
          workerHeartbeat.assertResponsive(expiresAt);
        } catch (error) {
          abortLost(error);
          throw leaseLost.signal.reason;
        }
        // Worker acknowledgement is liveness only. Recheck persisted ownership
        // after waiting, including inside a caller's already-held transaction.
        assertActive();
        verifyLeaseOwnership(params);
      }
    };
    const renewForHandoff = () => {
      const params = { ...identity, database: validated.database };
      try {
        return renew({
          ...params,
          operationLabel: validated.operationLabel,
          leaseMs: validated.leaseMs,
        });
      } catch (error) {
        if (!isLeaseWriteContention(error)) {
          throw error;
        }
        return verifyLeaseOwnership(params);
      }
    };
    const startWorker = async (expiresAt: number) => {
      const start = async (startupContext?: OpenClawStateWorkerContext) => {
        let started: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;
        let startupCleanup: LeaseHeartbeatCleanup | undefined;
        try {
          started = startOpenClawStateLeaseHeartbeat({
            path: workerStorage?.path ?? resolveLeaseDatabasePath(validated.database),
            existingOnly: !workerStorage && validated.database.schemaPolicy === "existing",
            startupContext,
            identity,
            leaseMs: validated.leaseMs,
            acquiredAt,
            heartbeatMs,
            expiresAt,
            onLost: abortLost,
            expiryObservation,
            renewDuringStartup: () => {
              assertActive();
              if (!workerStorage || !workerOperations) {
                return renewForHandoff();
              }
              const execution = workerOperations;
              return workerStorage
                .renew(execution, validated.leaseMs, validated.operationLabel, operationSignal)
                .catch((error: unknown) => {
                  execution.rethrowIfUncertain(error, undefined);
                  if (!isLeaseWriteContention(error)) {
                    throw error;
                  }
                  return workerStorage.verify(execution, operationSignal);
                });
            },
            retainCleanup(heartbeatCleanup) {
              startupCleanup = heartbeatCleanup;
              heartbeatCleanups.add(heartbeatCleanup);
              heartbeatStopped = false;
            },
          });
          startingHeartbeat = started;
          if (validated.signal?.aborted || leaseLost.signal.aborted) {
            stopWorker();
          }
          await started.ready;
          assertActive();
          startupContext?.admission.assertCurrent();
          workerHeartbeat = started;
        } catch (error) {
          try {
            await startupCleanup?.close();
            heartbeatStopped = [...heartbeatCleanups].every((entry) => !entry.pending);
          } catch (stopError) {
            throw createSqliteLifecycleAggregateError(
              [error, stopError],
              "state lease heartbeat startup and stop failed",
              error,
            );
          }
          throw error;
        } finally {
          if (heartbeatStopped || workerHeartbeat === started) {
            startingHeartbeat = undefined;
          }
        }
      };
      if (workerStorage) {
        await workerStorage.withRetainedStartup(start, assertActive);
      } else {
        await start();
      }
    };
    fileExclusion = workerStorage
      ? undefined
      : createOpenClawStateLeaseExclusion({
          databasePath: () => resolveLeaseDatabasePath(validated.database),
          assertActive,
          readExpiry: (databasePath) => {
            if (resolveLeaseDatabasePath(validated.database) !== databasePath) {
              throw invalidInput("state lease database path changed during exclusion");
            }
            return readLeaseDatabase(validated.database, (db) =>
              assertLeaseOwnedInDatabase(db, identity),
            );
          },
          pause: async () => {
            confirmedExpiresAt = renewForHandoff();
            clearInterval(heartbeat);
            clearTimeout(expiryTimer);
            heartbeat = undefined;
            expiryTimer = undefined;
            await workerHeartbeat?.stop();
            workerHeartbeat = undefined;
          },
          resume: async (expiresAt) => {
            confirmedExpiresAt = expiresAt;
            if (validated.heartbeat === "worker") {
              await startWorker(expiresAt);
            } else {
              renewAndSchedule();
              heartbeat = setInterval(renewFromTimer, heartbeatMs);
              heartbeat.unref?.();
            }
            assertDatabaseOwner();
          },
          onLost: (error) => {
            if (!validated.signal?.aborted) {
              abortLost(error);
            }
          },
        });

    const drain = async () => {
      await timerHeartbeat?.stopRenewal();
      const errors: unknown[] = [];
      for (const finish of [() => workerOperations?.drain(), () => fileExclusion?.drain()]) {
        try {
          await finish();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw createSqliteLifecycleAggregateError(errors, "state lease drainage failed", errors[0]);
      }
    };

    let result: T;
    try {
      const execution = workerOperations;
      if (validated.heartbeat === "worker") {
        validated.signal?.addEventListener("abort", stopWorker, { once: true });
        await startWorker(confirmedExpiresAt);
        asyncOwnership = workerStorage ? workerHeartbeat : undefined;
      } else if (workerStorage) {
        if (!execution || !expiryObservation) {
          throw new Error("Async state lease timer owner is unavailable");
        }
        const timer = workerStorage.startTimer(execution, {
          observation: expiryObservation,
          heartbeatMs,
          leaseMs: validated.leaseMs,
          operationLabel: validated.operationLabel,
          signal: operationSignal,
          onLost: abortLost,
        });
        timerHeartbeat = timer;
        asyncOwnership = timer;
        heartbeatStopped = false;
        operationSignal.addEventListener("abort", stopTimer, { once: true });
        if (operationSignal.aborted) {
          stopTimer();
        }
      } else {
        scheduleExpiry();
        heartbeat = setInterval(renewFromTimer, heartbeatMs);
        heartbeat.unref?.();
      }
      // Acquisition and callback entry are separate scheduling points. A
      // suspended process must not enter after its persisted lease expires.
      if (invocation.kind === "worker") {
        const verification = asyncOwnership;
        if (!execution || !verification) {
          throw new Error("Async state lease heartbeat did not start");
        }
        const verify = async (renewLease = false) => {
          assertActive();
          const expiresAt = await (renewLease ? verification.renew() : verification.verify());
          assertActive();
          workerHeartbeat?.assertRunning();
          confirmedExpiresAt = expiresAt;
        };
        await verify();
        const lease: OpenClawStateAsyncLeaseContext = {
          signal: operationSignal,
          assertOwned: async () => execution.run(() => verify()),
          renew: async () => execution.run(() => verify(true)),
        };
        execution.bind(lease);
        result = await invocation.run(lease);
      } else {
        assertOperationOwned();
        if (!fileExclusion) {
          throw new Error("Native state lease exclusion owner is unavailable");
        }
        const exclusion = fileExclusion;
        result = await exclusion.runWithOwnerScope(() => {
          const lease: OpenClawStateLeaseContext = {
            withDatabaseFileExclusion: (operation, bindCaptured) =>
              exclusion.run(operation, bindCaptured),
            signal: operationSignal,
            renew: renewOperation,
            assertOwned: assertOperationOwned,
            assertOwnedInTransaction: assertOperationOwned,
          };
          workerOperations = createOpenClawStateLeaseWorkerOwner({
            lease,
            identity: { scope: identity.scope, key: identity.key, owner: identity.owner },
            databasePath: resolveLeaseDatabasePath(validated.database),
            assertCurrent: () => {
              assertActive();
              if (
                validated.heartbeat === "worker" ||
                validated.database.schemaPolicy === "existing" ||
                exclusion.assertIfExcluded()
              ) {
                throw new Error("This lease mode does not support worker writes");
              }
              // A delayed expiry timer must not admit another synchronous effect.
              if (confirmedExpiresAt === undefined || Date.now() >= confirmedExpiresAt) {
                abortLost();
                assertActive();
              }
            },
          });
          return invocation.run(lease);
        });
      }
      await drain();
    } catch (error) {
      let failure = error;
      try {
        await drain();
      } catch (drainError) {
        if (drainError !== error) {
          failure = createSqliteLifecycleAggregateError(
            [error, drainError],
            "state lease operation and drainage failed",
            error,
          );
        }
      }
      const authorityError: unknown = leaseLost.signal.aborted
        ? leaseLost.signal.reason
        : validated.signal?.aborted
          ? abortError(validated.signal, "operation", validated.leaseLabel)
          : undefined;
      workerOperations?.rethrowIfUncertain(failure, authorityError);
      if (authorityError instanceof Error) {
        if (failure !== error && authorityError instanceof OpenClawStateLeaseError) {
          // Nested owners may observe the same failed capture differently. Keep
          // the caller's authority code and all operation/drainage causes.
          throw leaseError(authorityError.code, authorityError.message, failure);
        }
        throw authorityError;
      }
      throw failure;
    }
    if (workerStorage) {
      assertActive();
      await asyncOwnership?.verify();
      assertActive();
    } else {
      assertOperationOwned();
    }
    return result;
  };
  return cleanup.run(run, () => {
    phase = "draining";
    closed = true;
    unregisterProcessExitCleanup?.();
    validated.signal?.removeEventListener("abort", stopWorker);
    operationSignal.removeEventListener("abort", stopTimer);
    clearInterval(heartbeat);
    clearTimeout(expiryTimer);
    heartbeat = undefined;
    expiryTimer = undefined;
  });
}
