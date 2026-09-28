import type {
  WorkerInferenceCancelParams,
  WorkerInferenceErrorReason,
  WorkerInferenceStartParams,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { ActiveInference, RevalidateInference } from "./inference.types.js";

export type WorkerInferenceSessionDrain = {
  drained: Promise<void>;
  hasWork(): boolean;
  release(): void;
};

export type AcceptedWorkerInferenceSessionDrain = WorkerInferenceSessionDrain & {
  start(): void;
};

type WorkerInferenceSessionDrainReservation = {
  assertReserved(): void;
  accept(): AcceptedWorkerInferenceSessionDrain;
  release(): void;
};

export class WorkerInferenceSessionDrainBusyError extends Error {
  constructor(sessionId: string) {
    super(`Worker inference drain already owns session ${sessionId}`);
  }
}

export type WorkerInferenceCancellation = {
  readonly runIds: readonly string[];
  cancel(control?: {
    assertCurrent?: () => void;
    onCancelled?: (runId: string) => void;
  }): Promise<string[]>;
};

type WorkerInferenceSessionControl = {
  reserveDrain: (sessionId: string) => WorkerInferenceSessionDrainReservation;
  captureCancel: (sessionId: string, runId?: string) => WorkerInferenceCancellation;
  resolveTarget: (runId: string) => BoundAgentRunSessionTarget | undefined;
};

// Session lifecycle needs a stronger control without widening the inferred public service shape.
// The weak registration follows the concrete service instance's lifetime.
const sessionControlByService = new WeakMap<object, WorkerInferenceSessionControl>();

export function registerWorkerInferenceSessionControl(
  service: object,
  control: WorkerInferenceSessionControl,
): void {
  sessionControlByService.set(service, control);
}

export function reserveWorkerInferenceSessionDrain(
  service: unknown,
  sessionId: string,
): WorkerInferenceSessionDrainReservation | undefined {
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  return sessionControlByService.get(service)?.reserveDrain(sessionId);
}

export function captureWorkerInferenceCancellation(
  service: unknown,
  sessionId: string,
  runId?: string,
): WorkerInferenceCancellation | undefined {
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  return sessionControlByService.get(service)?.captureCancel(sessionId, runId);
}

export function resolveWorkerInferenceTarget(
  service: unknown,
  runId: string,
): BoundAgentRunSessionTarget | undefined {
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  return sessionControlByService.get(service)?.resolveTarget(runId);
}

export function safeRevalidate(
  revalidate?: RevalidateInference,
  onFailure?: (error: unknown) => void,
  assertSourceCurrent?: () => void,
): WorkerInferenceErrorReason | null {
  try {
    assertSourceCurrent?.();
    return revalidate?.() ?? null;
  } catch (error) {
    onFailure?.(error);
    return "provider-error";
  }
}

export function matchesIdentity(
  identity: WorkerConnectionIdentity,
  request: WorkerInferenceStartParams | WorkerInferenceCancelParams,
): WorkerInferenceErrorReason | null {
  const claim = identity.turnClaim;
  if (
    !claim ||
    identity.sessionId !== request.sessionId ||
    identity.runId !== request.runId ||
    claim.sessionId !== request.sessionId ||
    claim.runId !== request.runId
  ) {
    return "session-not-attached";
  }
  if (identity.ownerEpoch !== request.runEpoch) {
    return "epoch-mismatch";
  }
  return null;
}

export class WorkerInferenceAuthorityError extends Error {
  constructor(
    readonly reason: WorkerInferenceErrorReason,
    cause?: unknown,
  ) {
    super(`Worker inference authority changed: ${reason}`, { cause });
  }
}

export function preserveInferenceAuthorityFailure(
  error: unknown,
  authorityFailure?: { error: unknown },
): unknown {
  if (!authorityFailure || error === authorityFailure.error) {
    return error;
  }
  // Unwrap a host refusal only after its native settlement is known.
  if (
    error instanceof WorkerInferenceAuthorityError &&
    error.cause === authorityFailure.error &&
    !hasSqliteWorkerOutcomeUnknown(error)
  ) {
    return authorityFailure.error;
  }
  return new AggregateError(
    [authorityFailure.error, error],
    "Worker inference authority and settlement failed",
    { cause: error },
  );
}

export async function joinInferenceOperations(
  operations: Iterable<Promise<unknown>>,
  retainedFailures: Iterable<unknown> = [],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors = [
    ...new Set([
      ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ...retainedFailures,
    ]),
  ];
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worker inference settlement failed");
  }
}

export function createWorkerInferenceSessionControls(params: {
  active: ReadonlyMap<string, ActiveInference>;
  operations: ReadonlyMap<Promise<unknown>, Readonly<{ sessionId: string; storeKey: string }>>;
  unknownSettlements: ReadonlyMap<string, ReadonlySet<unknown>>;
  recovered: Promise<void>;
  settleAbort: (entry: ActiveInference, reason: WorkerInferenceErrorReason) => Promise<void>;
}) {
  const { active, operations, unknownSettlements, recovered, settleAbort } = params;
  const drainingSessions = new Map<string, Promise<void>>();
  let stoppingPromise: Promise<void> | undefined;
  let stopping = false;

  const captureCancellationEntries = (predicate: (entry: ActiveInference) => boolean) =>
    [...active.values()].filter(predicate).map((entry) => ({
      entry,
      claimKey: entry.claimKey,
      sessionId: entry.request.sessionId,
      runId: entry.request.runId,
      turnId: entry.request.turnId,
    }));
  const cancelCaptured = (
    captured: ReturnType<typeof captureCancellationEntries>,
    reason: WorkerInferenceErrorReason,
    control?: Parameters<WorkerInferenceCancellation["cancel"]>[0],
  ): Promise<void> => {
    const settling: Promise<void>[] = [];
    let failure: { error: unknown } | undefined;
    try {
      for (const { entry, claimKey, sessionId, runId, turnId } of captured) {
        control?.assertCurrent?.();
        if (
          active.get(claimKey) !== entry ||
          entry.claimKey !== claimKey ||
          entry.request.sessionId !== sessionId ||
          entry.request.runId !== runId ||
          entry.request.turnId !== turnId
        ) {
          continue;
        }
        settling.push(settleAbort(entry, reason));
        control?.onCancelled?.(runId);
      }
    } catch (error) {
      failure = { error };
    }
    return joinInferenceOperations(settling, failure ? [failure.error] : []);
  };
  const cancelWhere = (
    predicate: (entry: ActiveInference) => boolean,
    reason: WorkerInferenceErrorReason,
  ) => cancelCaptured(captureCancellationEntries(predicate), reason);
  const cancelEnvironment = (
    environmentId: string,
    reason: WorkerInferenceErrorReason = "session-not-attached",
  ): Promise<void> =>
    cancelWhere((entry) => entry.identity.environmentId === environmentId, reason);
  const cancelClaim = (claimKey: string): Promise<void> =>
    cancelWhere((entry) => entry.claimKey === claimKey, "session-not-attached");
  const captureSessionCancellation = (
    sessionId: string,
    runId?: string,
  ): WorkerInferenceCancellation => {
    const captured = captureCancellationEntries(
      (entry) =>
        entry.request.sessionId === sessionId &&
        (runId === undefined || entry.request.runId === runId),
    );
    return {
      runIds: [...new Set(captured.map((entry) => entry.runId))].toSorted(),
      cancel(control) {
        const cancelled = new Set<string>();
        const settled = cancelCaptured(captured, "cancelled", {
          assertCurrent: control?.assertCurrent,
          onCancelled(cancelledRunId) {
            cancelled.add(cancelledRunId);
            control?.onCancelled?.(cancelledRunId);
          },
        });
        return settled.then(() => [...cancelled].toSorted());
      },
    };
  };
  const cancelSession = (sessionId: string, runId?: string): Promise<string[]> =>
    captureSessionCancellation(sessionId, runId).cancel();
  const hasSession = (sessionId: string, runId?: string): boolean =>
    [...active.values()].some(
      (entry) =>
        entry.request.sessionId === sessionId &&
        (runId === undefined || entry.request.runId === runId),
    );
  const hasSessionOperation = (sessionId: string): boolean =>
    [...operations.values()].some((owner) => owner.sessionId === sessionId);

  const reserveSessionDrain = (sessionId: string): WorkerInferenceSessionDrainReservation => {
    const captured = captureCancellationEntries((entry) => entry.request.sessionId === sessionId);
    const entries = new Set(captured.map(({ entry }) => entry));
    const capturedOperations = new Set(
      [...operations].flatMap(([operation, owner]) =>
        owner.sessionId === sessionId ? [operation] : [],
      ),
    );
    const capturedStoreKeys = new Set([
      ...captured.map(({ entry }) => entry.storeKey),
      ...[...operations.values()]
        .filter((owner) => owner.sessionId === sessionId)
        .map((owner) => owner.storeKey),
    ]);
    let reserved = true;
    let accepted: ReturnType<WorkerInferenceSessionDrainReservation["accept"]> | undefined;
    const assertReserved = () => {
      if (!reserved) {
        throw new Error("Worker inference drain reservation is no longer pending");
      }
      if (drainingSessions.has(sessionId)) {
        throw new WorkerInferenceSessionDrainBusyError(sessionId);
      }
      if (
        [...active.values()].some(
          (entry) => entry.request.sessionId === sessionId && !entries.has(entry),
        ) ||
        [...operations].some(
          ([operation, owner]) =>
            owner.sessionId === sessionId && !capturedOperations.has(operation),
        )
      ) {
        throw new Error("Worker inference registrations changed before drain acceptance");
      }
    };
    return {
      assertReserved,
      accept() {
        assertReserved();
        reserved = false;
        let started = false;
        let settled = false;
        let releaseRequested = false;
        let released = false;
        const release = () => {
          releaseRequested = true;
          if (settled && !released) {
            released = true;
            if (drainingSessions.get(sessionId) === drained) {
              drainingSessions.delete(sessionId);
            }
          }
        };
        const startedSignal = createDeferredCore();
        let cancelling: Promise<void> | undefined;
        const drained = startedSignal.promise.then(() =>
          joinInferenceOperations(
            [...capturedOperations, cancelling!],
            [...capturedStoreKeys].flatMap((storeKey) =>
              Array.from(unknownSettlements.get(storeKey) ?? []),
            ),
          ),
        );
        drainingSessions.set(sessionId, drained);
        const settle = () => {
          settled = true;
          if (releaseRequested) {
            release();
          }
        };
        void drained.then(settle, settle);
        accepted = {
          drained,
          hasWork: () => hasSession(sessionId) || hasSessionOperation(sessionId),
          start() {
            if (!started) {
              started = true;
              cancelling = cancelCaptured(captured, "cancelled");
              startedSignal.resolve();
            }
          },
          release,
        };
        return accepted;
      },
      release() {
        reserved = false;
        accepted?.release();
      },
    };
  };
  const resolveSessionTargetForRunId = (runId: string): BoundAgentRunSessionTarget | undefined => {
    let target: BoundAgentRunSessionTarget | undefined;
    for (const entry of active.values()) {
      if (entry.request.runId !== runId) {
        continue;
      }
      const source = entry.sessionTarget;
      if (
        target &&
        (source.agentId !== target.agentId ||
          source.sessionId !== target.sessionId ||
          source.sessionKey !== target.sessionKey ||
          source.storePath !== target.storePath ||
          source.expectedLifecycleRevision !== target.expectedLifecycleRevision ||
          source.expectedWriterRunId !== target.expectedWriterRunId)
      ) {
        return undefined;
      }
      target = source;
    }
    return target;
  };
  const stop = (): Promise<void> => {
    if (stoppingPromise) {
      return stoppingPromise;
    }
    stopping = true;
    const stopped = createDeferredCore();
    stoppingPromise = stopped.promise;
    const acceptedDrains = new Map(drainingSessions);
    const cancelling = cancelWhere(
      (entry) => !acceptedDrains.has(entry.request.sessionId),
      "provider-error",
    );
    void joinInferenceOperations(
      [recovered, ...operations.keys(), ...acceptedDrains.values(), cancelling],
      [...unknownSettlements.values()].flatMap((errors) => Array.from(errors)),
    ).then(stopped.resolve, stopped.reject);
    return stoppingPromise;
  };

  return {
    isStopping: () => stopping,
    isDraining: (sessionId: string) => drainingSessions.has(sessionId),
    getClosing: (sessionId: string) => drainingSessions.get(sessionId) ?? stoppingPromise,
    cancelEnvironment,
    cancelClaim,
    cancelSession,
    captureSessionCancellation,
    reserveSessionDrain,
    hasSession,
    resolveSessionTargetForRunId,
    stop,
  };
}
