import { isDeepStrictEqual } from "node:util";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  WorkerDispatchPlacement,
  WorkerProvisioningDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import { matchesWorkerPlacementTarget } from "./placement-reclaim-contract.js";
import type { WorkerPlacementRecoveryAdmission } from "./placement-recovery-contract.js";
import type {
  WorkerPlacementDispatchAdmission,
  WorkerPlacementCancellationTarget,
} from "./service-contract.js";

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
    superseded: new AbortController(),
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
): WorkerPlacementDispatchService & {
  /** Lend admission while interrupting session work and waiting for its turn claim. */
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
  type ClaimWait = { settled: Promise<void> };
  const claimWaits = new Map<string, ClaimWait>();
  const pendingTargetedRecoveries = new Map<string, Set<(loan?: ClaimWait) => void>>();
  const lendRecovery = (loan: ClaimWait, run: Parameters<WorkerPlacementRecoveryAdmission>[1]) => {
    const recovery = loan.settled.then(() => run("results-only"));
    loan.settled = recovery.then(
      () => undefined,
      () => undefined,
    );
    return recovery;
  };
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
      const targetedSession = wait && sessionIds.length === 1 ? sessionIds[0] : undefined;
      const claimWait = targetedSession === undefined ? undefined : claimWaits.get(targetedSession);
      if (claimWait) {
        await lendRecovery(claimWait, run);
        return true;
      }
      if (!wait && sessionIds.some((key) => sessionTails.has(key) || operationsInFlight.has(key))) {
        return false;
      }
      const admission = reserveSessions(sessionIds);
      if (targetedSession !== undefined) {
        const completion = createDeferredCore();
        const pending = pendingTargetedRecoveries.get(targetedSession) ?? new Set();
        let started = false;
        const start = (loan?: ClaimWait) => {
          if (started) {
            return;
          }
          started = true;
          pending.delete(start);
          if (pending.size === 0) {
            pendingTargetedRecoveries.delete(targetedSession);
          }
          const recovery = loan ? lendRecovery(loan, run) : Promise.resolve().then(() => run());
          void recovery.then(completion.resolve, completion.reject);
        };
        pending.add(start);
        pendingTargetedRecoveries.set(targetedSession, pending);
        void admission.ready.then(() => start());
        // A loan settles the callback, not its queue position: successors still wait
        // for the original holder through this reservation's captured predecessor.
        await admission.hold(completion.promise);
        return true;
      }
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
    // A new lifecycle operation permanently invalidates waiters on its predecessor,
    // even if Stop/Move/replacement finishes before that predecessor resolves.
    for (const predecessor of pending) {
      predecessor.superseded.abort(
        new Error("Worker setup was superseded by another placement operation"),
      );
    }
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
  return {
    async awaitTurnClaimRelease(sessionId, wait) {
      const claimWait = { settled: Promise.resolve() };
      claimWaits.set(sessionId, claimWait);
      try {
        for (const start of pendingTargetedRecoveries.get(sessionId) ?? []) {
          start(claimWait);
        }
        await wait();
      } finally {
        // Close before joining: later units must queue behind the original holder.
        claimWaits.delete(sessionId);
        await claimWait.settled;
      }
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
      const superseded = new AbortController();
      let recoveryFailure: { error: unknown } | undefined;
      const waitSignal = signal ? AbortSignal.any([signal, superseded.signal]) : superseded.signal;
      let nextOwner = createDeferredCore<PlacementOperation>();
      const observe = (owner: PlacementOperation) => {
        // A restart can leave a gap between provider recovery passes. Stop, Move, or
        // replacement during that gap still permanently invalidates the held input.
        if (pendingOperations(placement.sessionId).length !== 1 || !matchesOwner(owner)) {
          superseded.abort(missingOwner());
        } else {
          nextOwner.resolve(owner);
        }
      };
      const waiters = setupWaiters.get(placement.sessionId) ?? new Set();
      waiters.add(observe);
      setupWaiters.set(placement.sessionId, waiters);
      try {
        if (initialOwner) {
          nextOwner.resolve(initialOwner);
        } else if (recover) {
          // Subscribe before waking the existing guarded recovery owner. Its environment
          // coordinator deduplicates concurrent waiters and owns subsequent provider passes.
          void recover().catch((error: unknown) => {
            recoveryFailure = { error };
            superseded.abort(error);
          });
        }
        for (;;) {
          const owner = await racePromiseWithAbortSignal(nextOwner.promise, waitSignal);
          nextOwner = createDeferredCore<PlacementOperation>();
          const ownerSignal = AbortSignal.any([waitSignal, owner.superseded.signal]);
          const completed = await racePromiseWithAbortSignal(owner.operation, ownerSignal);
          ownerSignal.throwIfAborted();
          if (completed && matchesWorkerPlacementTarget(owner.completedPlacement(), completed)) {
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
      } catch (error) {
        throw recoveryFailure ? recoveryFailure.error : error;
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
          (signal) => {
            signal?.throwIfAborted();
            const admission = reserveSessions([request.sessionId]);
            return admission.hold(
              (async () => {
                await racePromiseWithAbortSignal(admission.ready, signal);
                signal?.throwIfAborted();
                return await service.dispatch(request, report, authorize, signal);
              })(),
            );
          },
          authorize,
          callerSignal,
        );
      }, onTransition);
      const { operation } = tracked;
      registerOperation({ kind: "dispatch", request, ...tracked });
      return await operation;
    },
    forceDestroyEnvironment: async (environmentId, onCleanupError) => {
      const knownSessionIds = new Set(service.getEnvironmentAttachedSessionIds(environmentId));
      for (const [sessionId, operations] of operationsInFlight) {
        if (
          [...operations].some(
            (operation) => operation.currentPlacement()?.environmentId === environmentId,
          )
        ) {
          knownSessionIds.add(sessionId);
        }
      }
      const admission = reserveSessions([...knownSessionIds]);
      return await admission.hold(
        (async () => {
          const sessionIds = await service.readEnvironmentSessionIds(environmentId);
          // Durable-only owners had no attachment or live operation here at call time.
          // Skip busy owners: intervening lifecycle writes are CAS-guarded and environment
          // effects use environment/workspace locks; overlapping destroys are ordered by
          // a shared phase-1 key. Waiting here while holding phase 1 can deadlock on growth.
          const durableAdmission = reserveSessions(
            sessionIds.filter(
              (sessionId) =>
                !knownSessionIds.has(sessionId) &&
                !sessionTails.has(sessionId) &&
                !operationsInFlight.has(sessionId),
            ),
          );
          return await durableAdmission.hold(
            (async () => {
              await admission.ready;
              return await service.forceDestroyEnvironment(environmentId, onCleanupError);
            })(),
          );
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
          (signal) => {
            signal?.throwIfAborted();
            const admission = reserveSessions([request.sessionId]);
            return admission.hold(
              (async () => {
                await racePromiseWithAbortSignal(admission.ready, signal);
                signal?.throwIfAborted();
                return await service.move(request, report, authorize, signal);
              })(),
            );
          },
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
          (run) => {
            const admission = reserveSessions([request.sessionId]);
            return admission.hold(
              (async () => {
                await admission.ready;
                return await run();
              })(),
            );
          },
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
            admitDispatch(placement, async (signal) => {
              try {
                signal?.throwIfAborted();
                const recovered = await runRecovery(signal);
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
}
