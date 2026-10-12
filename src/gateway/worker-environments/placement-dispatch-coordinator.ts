import { isDeepStrictEqual } from "node:util";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { composePlacementAuthorization } from "./placement-authorization.js";
import type {
  WorkerDispatchPlacement,
  WorkerProvisioningDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementRecoveryAdmission } from "./placement-recovery-contract.js";
import {
  matchesWorkerPlacementTarget,
  type WorkerPlacementCancellationTarget,
} from "./placement-target.js";
import type { WorkerPlacementDispatchAdmission } from "./service-contract.js";
import { ensureWorkerSessionPlacement } from "./session-placement-lifecycle.js";

function trackPlacementOperation<T extends WorkerDispatchPlacement | void>(
  run: (report: (placement: WorkerDispatchPlacement) => void) => Promise<T>,
  onTransition?: (placement: WorkerDispatchPlacement) => void,
) {
  let current: WorkerPlacementCancellationTarget | undefined;
  let completed: WorkerPlacementCancellationTarget | undefined;
  const record = (placement: WorkerDispatchPlacement) => {
    // Retain the producer's authority by value before an observer can mutate its snapshot.
    current = {
      state: placement.state,
      generation: placement.generation,
      environmentId: placement.environmentId,
      activeOwnerEpoch: placement.activeOwnerEpoch,
    };
  };
  return {
    currentPlacement: () => current,
    completedPlacement: () => completed,
    operation: run((placement) => {
      record(placement);
      onTransition?.({ ...placement });
    }).then((placement) => {
      // Completion can outlive the map entry while Stop is loading cancellation support.
      if (placement) {
        record(placement);
        completed = current;
      }
      return placement;
    }),
  };
}

/** Orders placement work per session and deduplicates exact lifecycle requests. */
export function coordinateWorkerPlacementDispatch(
  service: WorkerPlacementDispatchService,
  admitDispatch: WorkerPlacementDispatchAdmission,
  recoverInitialPlacement?: (placement: WorkerProvisioningDispatchPlacement) => Promise<void>,
  reportReconciliation?: (operation: () => Promise<void>) => Promise<void>,
  sessionPreparation?: Pick<
    Parameters<typeof ensureWorkerSessionPlacement>[0],
    "placements" | "environments" | "redispatchPlacement"
  > & { warn: (message: string) => void },
): WorkerPlacementDispatchService & {
  ensurePlacement(
    params: Omit<
      Parameters<typeof ensureWorkerSessionPlacement>[0],
      | "placements"
      | "environments"
      | "redispatchPlacement"
      | "dispatch"
      | "startDispatch"
      | "waitForInitialPlacement"
    >,
  ): ReturnType<typeof ensureWorkerSessionPlacement>;
  /** Wait for interrupted session work to release its turn claim. */
  awaitTurnClaimRelease(sessionId: string, wait: () => Promise<void>): Promise<void>;
  isPlacementOperationInFlight(sessionId: string): boolean;
  hasPendingPlacementLifecycleOperation(sessionId: string): boolean;
  getPendingDeviceDispatchCount(deviceId: string, excludeSessionId?: string): number;
  waitForInitialPlacement(
    this: void,
    placement: WorkerDispatchPlacement,
    signal?: AbortSignal,
  ): Promise<WorkerDispatchPlacement>;
} {
  const sessionTails = new Map<string, Promise<void>>();
  const reserveSessions = (sessionIds: readonly string[]) => {
    const keys = [...new Set(sessionIds)];
    const ready = Promise.all(keys.map((key) => sessionTails.get(key) ?? Promise.resolve())).then(
      () => undefined,
    );
    const settled = createDeferredCore();
    // Register every key before yielding. Captured predecessors make multi-key admission
    // acyclic, and cancellation cannot release a predecessor's still-running work.
    const tail = ready.then(() => settled.promise);
    for (const key of keys) {
      sessionTails.set(key, tail);
    }
    void tail.then(() => {
      for (const key of keys) {
        if (sessionTails.get(key) === tail) {
          sessionTails.delete(key);
        }
      }
    });
    return {
      ready,
      hold<T>(operation: Promise<T>): Promise<T> {
        void operation.then(
          () => settled.resolve(),
          () => settled.resolve(),
        );
        return operation;
      },
    };
  };
  const recoveryAdmission =
    (wait: boolean): WorkerPlacementRecoveryAdmission =>
    async (sessionIds, run) => {
      if (sessionIds.some((key) => sessionTails.has(key) || operationsInFlight.has(key))) {
        if (!wait || sessionIds.length !== 1) {
          return false;
        }
        // Result recovery may release the claim a lifecycle operation is awaiting.
        // Its durable result owner already serializes writes; it needs no queue handoff.
        await run("results-only");
        return true;
      }
      const admission = reserveSessions(sessionIds);
      // Only recovery units enter here. Environment reconciliation stays outside admission
      // because its recovery guard can re-enter this session.
      await admission.hold(
        (async () => {
          await admission.ready;
          await run();
        })(),
      );
      return true;
    };
  const tryRecovery = recoveryAdmission(false);
  const waitRecovery = recoveryAdmission(true);
  let fullSweep: Promise<void> | undefined;
  const runReconciliation = (operation: () => Promise<void>, full = true): Promise<void> => {
    if (full && fullSweep) {
      return fullSweep;
    }
    const current = reportReconciliation ? reportReconciliation(operation) : operation();
    if (full) {
      fullSweep = current;
      const release = () => {
        if (fullSweep === current) {
          fullSweep = undefined;
        }
      };
      void current.then(release, release);
    }
    return current;
  };
  type OperationServices = Pick<WorkerPlacementDispatchService, "dispatch" | "move" | "reclaim"> & {
    recovery: WorkerPlacementDispatchService["resumeProvisioning"];
  };
  type PlacementOperation = {
    [Kind in keyof OperationServices]: {
      kind: Kind;
      request: Parameters<OperationServices[Kind]>[0];
    } & ReturnType<typeof trackPlacementOperation<Awaited<ReturnType<OperationServices[Kind]>>>> &
      (Kind extends "recovery"
        ? { foreground: ReturnType<WorkerPlacementDispatchService["resumeProvisioning"]> }
        : unknown);
  }[keyof OperationServices];
  const operationsInFlight = new Map<string, Set<PlacementOperation>>();
  const setupWaiters = new Map<string, Set<(operation: PlacementOperation) => void>>();
  const pendingOperations = (sessionId: string) => [...(operationsInFlight.get(sessionId) ?? [])];
  const registerOperation = (record: PlacementOperation) => {
    const pending = operationsInFlight.get(record.request.sessionId) ?? new Set();
    pending.add(record);
    operationsInFlight.set(record.request.sessionId, pending);
    for (const observe of setupWaiters.get(record.request.sessionId) ?? []) {
      observe(record);
    }
    const release = () => {
      pending.delete(record);
      if (pending.size === 0) {
        operationsInFlight.delete(record.request.sessionId);
      }
    };
    void record.operation.then(release, release);
  };
  const joinOperation = async <T>(operation: Promise<T>, authorize?: () => void): Promise<T> => {
    // Shared placement work must never inherit another caller's authority across an await.
    authorize?.();
    const result = await operation;
    authorize?.();
    return result;
  };
  const runSessionOperation = <T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    signal?.throwIfAborted();
    const admission = reserveSessions([sessionId]);
    return admission.hold(
      (async () => {
        await racePromiseWithAbortSignal(admission.ready, signal);
        signal?.throwIfAborted();
        return await run();
      })(),
    );
  };
  const coordinator: ReturnType<typeof coordinateWorkerPlacementDispatch> = {
    async ensurePlacement(params) {
      if (!sessionPreparation) {
        throw new Error("Session placement preparation is unavailable");
      }
      return await ensureWorkerSessionPlacement({
        ...sessionPreparation,
        ...params,
        dispatch: coordinator.dispatch,
        waitForInitialPlacement: coordinator.waitForInitialPlacement,
        startDispatch: async (request, onTransition, authorize, signal) => {
          const started = createDeferredCore<WorkerDispatchPlacement>();
          const operation = coordinator.dispatch(
            request,
            (placement) => {
              started.resolve(placement);
              onTransition?.(placement);
            },
            authorize,
            signal,
          );
          void operation.catch((error: unknown) => {
            try {
              sessionPreparation.warn("Worker setup failed: " + String(error));
            } catch {
              /* Reporting cannot replace durable setup failure. */
            }
          });
          return await Promise.race([started.promise, operation]);
        },
      });
    },
    async awaitTurnClaimRelease(_sessionId, wait) {
      await wait();
    },
    isPlacementOperationInFlight: (sessionId) => operationsInFlight.has(sessionId),
    hasPendingPlacementLifecycleOperation: (sessionId) =>
      pendingOperations(sessionId).some((operation) => operation.kind !== "recovery"),
    getPendingDeviceDispatchCount(deviceId, excludeSessionId) {
      let count = 0;
      for (const [sessionId, operations] of operationsInFlight) {
        if (sessionId === excludeSessionId) {
          continue;
        }
        for (const operation of operations) {
          if (
            operation.kind === "dispatch" &&
            operation.request.executionMode === "worker-turn" &&
            operation.request.deviceId === deviceId
          ) {
            count += 1;
          }
        }
      }
      return count;
    },
    async waitForInitialPlacement(placement, signal) {
      signal?.throwIfAborted();
      const pending = pendingOperations(placement.sessionId);
      const matchesOwner = (owner: PlacementOperation) =>
        (owner.kind === "dispatch" || owner.kind === "recovery") &&
        owner.request.sessionKey === placement.sessionKey &&
        owner.request.agentId === placement.agentId &&
        matchesWorkerPlacementTarget(
          owner.currentPlacement() ?? (owner.kind === "recovery" ? owner.request : undefined),
          placement,
        );
      const missingOwner = () =>
        new Error(
          "Worker setup has no matching live dispatch owner. Wait for recovery or explicitly retry setup.",
        );
      const initialOwner = pending.length === 1 ? pending[0] : undefined;
      const recover =
        recoverInitialPlacement && placement.state === "provisioning" && placement.environmentId
          ? () => recoverInitialPlacement(placement)
          : undefined;
      if (pending.length ? !initialOwner || !matchesOwner(initialOwner) : !recover) {
        throw missingOwner();
      }
      let nextOwner = createDeferredCore<PlacementOperation | undefined>();
      const observe = (owner: PlacementOperation) =>
        nextOwner.resolve(matchesOwner(owner) ? owner : undefined);
      const waiters = setupWaiters.get(placement.sessionId) ?? new Set();
      waiters.add(observe);
      setupWaiters.set(placement.sessionId, waiters);
      try {
        if (initialOwner) {
          nextOwner.resolve(initialOwner);
        } else if (recover) {
          void recover().catch(nextOwner.reject);
        }
        for (;;) {
          const owner = await racePromiseWithAbortSignal(nextOwner.promise, signal);
          if (!owner) {
            throw missingOwner();
          }
          nextOwner = createDeferredCore<PlacementOperation | undefined>();
          const completed = await racePromiseWithAbortSignal(owner.operation, signal);
          if (completed) {
            return completed;
          }
          if (
            !completed &&
            recover &&
            owner.kind === "recovery" &&
            matchesWorkerPlacementTarget(owner.currentPlacement(), placement)
          ) {
            continue;
          }
          throw new Error(
            "Worker setup did not publish a ready placement. Inspect the setup recovery error.",
          );
        }
      } finally {
        waiters.delete(observe);
        if (waiters.size === 0) {
          setupWaiters.delete(placement.sessionId);
        }
      }
    },
    dispatch: async (request, onTransition, authorize, callerSignal) => {
      callerSignal?.throwIfAborted();
      const inFlight = pendingOperations(request.sessionId).find(
        (pending) => pending.kind === "dispatch",
      );
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already dispatching another request`);
        }
        return await racePromiseWithAbortSignal(
          joinOperation(inFlight.operation, authorize),
          callerSignal,
        );
      }
      // Capture only earlier Stops. A later Stop must drain this dispatch, not precede it.
      const predecessors = pendingOperations(request.sessionId).filter(
        (pending) => pending.kind === "reclaim",
      );
      const tracked = trackPlacementOperation(async (report) => {
        await racePromiseWithAbortSignal(
          Promise.allSettled(predecessors.map((pending) => pending.operation)),
          callerSignal,
        );
        return await admitDispatch(
          request,
          (signal, assertSessionCurrent) =>
            runSessionOperation(request.sessionId, signal, () =>
              service.dispatch(
                request,
                report,
                composePlacementAuthorization(authorize, () => assertSessionCurrent?.()),
                signal,
              ),
            ),
          authorize,
          callerSignal,
        );
      }, onTransition);
      const { operation } = tracked;
      registerOperation({ kind: "dispatch", request, ...tracked });
      return await operation;
    },
    forceDestroyEnvironment: async (environmentId, onCleanupError) => {
      const sessionIds = new Set(await service.readEnvironmentSessionIds(environmentId));
      for (const sessionId of service.getEnvironmentAttachedSessionIds(environmentId)) {
        sessionIds.add(sessionId);
      }
      for (const [sessionId, operations] of operationsInFlight) {
        if (
          [...operations].some((entry) => entry.currentPlacement()?.environmentId === environmentId)
        ) {
          sessionIds.add(sessionId);
        }
      }
      const admission = reserveSessions([...sessionIds]);
      return await admission.hold(
        (async () => {
          await admission.ready;
          return await service.forceDestroyEnvironment(environmentId, onCleanupError);
        })(),
      );
    },
    move: async (request, onTransition, authorize) => {
      const inFlight = pendingOperations(request.sessionId).find(
        (pending) => pending.kind === "move",
      );
      if (inFlight) {
        if (!isDeepStrictEqual(inFlight.request, request)) {
          throw new Error(`Session ${request.sessionKey} is already moving to another target`);
        }
        return await joinOperation(inFlight.operation, authorize);
      }
      const predecessors = pendingOperations(request.sessionId).filter(
        (pending) => pending.kind === "reclaim",
      );
      const tracked = trackPlacementOperation(async (report) => {
        await Promise.allSettled(predecessors.map((pending) => pending.operation));
        return await admitDispatch(
          request,
          (signal, assertSessionCurrent) =>
            runSessionOperation(request.sessionId, signal, () =>
              service.move(
                request,
                report,
                composePlacementAuthorization(authorize, () => assertSessionCurrent?.()),
                signal,
              ),
            ),
          authorize,
        );
      }, onTransition);
      const { operation } = tracked;
      registerOperation({ kind: "move", request, ...tracked });
      return await operation;
    },
    reclaim: async (request, authorize, beforeDrain) => {
      // Preparation can need targeted recovery to release a turn claim. Enqueue only
      // entered cleanup; lifecycle tracking keeps later dispatches and Moves behind Stop.
      const operations = pendingOperations(request.sessionId).filter(
        (operation) =>
          operation.request.sessionKey === request.sessionKey &&
          operation.request.agentId === request.agentId,
      );
      const hasPendingDispatch = () =>
        operations.some(
          (operation) =>
            operation.kind !== "reclaim" &&
            operationsInFlight.get(request.sessionId)?.has(operation),
        );
      const isPending = () =>
        operations.some((operation) => operationsInFlight.get(request.sessionId)?.has(operation));
      // Generation increases within the lifecycle revalidated by the reclaim owner.
      // Dispatch, Move and predecessor Stop publish through the same transition owner.
      const latestPlacement = (read: "currentPlacement" | "completedPlacement") =>
        operations.reduce<WorkerPlacementCancellationTarget | undefined>((latest, pending) => {
          const current = pending[read]();
          return current && (!latest || current.generation > latest.generation) ? current : latest;
        }, undefined);
      const tracked = trackPlacementOperation((report) =>
        service.reclaim(
          request,
          authorize,
          beforeDrain,
          (run) => runSessionOperation(request.sessionId, undefined, run),
          operations.length
            ? {
                isCurrent: isPending,
                hasPendingDispatch,
                currentPlacement: () => latestPlacement("currentPlacement"),
                completedPlacement: () => latestPlacement("completedPlacement"),
                settled: Promise.allSettled(operations.map((pending) => pending.operation)),
              }
            : undefined,
          report,
        ),
      );
      const { operation } = tracked;
      registerOperation({ kind: "reclaim", request, ...tracked });
      return await operation;
    },
    getEnvironmentAttachedSessionIds: (environmentId) =>
      service.getEnvironmentAttachedSessionIds(environmentId),
    readEnvironmentSessionIds: (environmentId) => service.readEnvironmentSessionIds(environmentId),
    reconcile: (mode) => runReconciliation(() => service.reconcile(mode, tryRecovery)),
    reconcileActive: (environmentId) =>
      environmentId === undefined
        ? runReconciliation(() => service.reconcileActive(undefined, tryRecovery))
        : runReconciliation(() => service.reconcileActive(environmentId, waitRecovery), false),
    resumeProvisioning: (placement, reconcileEnvironmentCore) => {
      const inFlight = pendingOperations(placement.sessionId).find(
        (pending) => pending.kind === "recovery" && isDeepStrictEqual(pending.request, placement),
      );
      if (inFlight?.kind === "recovery") {
        // A timed-out provider retains admission after foreground recovery has finished.
        // Reuse that pass until it settles; a later sweep can then resume the same owner.
        return inFlight.foreground;
      }
      const admission = reserveSessions([placement.sessionId]);
      const foreground =
        createDeferredCore<
          Awaited<ReturnType<WorkerPlacementDispatchService["resumeProvisioning"]>>
        >();
      let providerSettlement = Promise.resolve();
      let providerPending = false;
      const tracked = trackPlacementOperation(async (report) => {
        await admission.ready;
        return await service.resumeProvisioning(
          placement,
          async (signal) => {
            await reconcileEnvironmentCore(signal, (settled) => {
              providerSettlement = settled;
              providerPending = true;
              const markSettled = () => {
                if (providerSettlement === settled) {
                  providerPending = false;
                }
              };
              void settled.then(markSettled, markSettled);
            });
          },
          report,
          (runRecovery) =>
            admitDispatch(placement, async (signal, assertSessionCurrent) => {
              try {
                signal?.throwIfAborted();
                assertSessionCurrent?.();
                const recovered = await runRecovery(signal);
                assertSessionCurrent?.();
                if (providerPending) {
                  foreground.resolve(recovered);
                }
                return recovered;
              } catch (error) {
                if (providerPending) {
                  foreground.reject(error);
                }
                throw error;
              } finally {
                // Foreground timeout does not release this session's provider ownership.
                await providerSettlement;
              }
            }),
        );
      });
      void admission.hold(tracked.operation);
      registerOperation({
        kind: "recovery",
        request: placement,
        ...tracked,
        foreground: foreground.promise,
      });
      // Ordinary completion must release the old operation before a caller can retry it.
      // Only a still-running provider may publish foreground completion ahead of that release.
      void tracked.operation.then(foreground.resolve, foreground.reject);
      return foreground.promise;
    },
  };
  return coordinator;
}
