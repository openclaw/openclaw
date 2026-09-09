import type {
  ChannelIngressActiveOperationSnapshot,
  ChannelIngressActiveOperationsSnapshot,
  ChannelIngressLifecycleObserver,
  ChannelIngressObservationRecordRef,
  ChannelIngressObserverController,
  ChannelIngressOperationKind,
  ChannelIngressOperationOutcome,
  ChannelIngressProgressUpdate,
} from "./ingress-observability-contract.js";

const STRING_LIMIT = 160;
const MAX_ACTIVE_OPERATIONS = 8;

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > STRING_LIMIT ? `${trimmed.slice(0, STRING_LIMIT)}...` : trimmed;
}

export async function observeChannelIngressDedupeWait<T>(
  observer: ChannelIngressLifecycleObserver | undefined,
  pending: Promise<T>,
): Promise<T> {
  let finish: ((outcome?: ChannelIngressOperationOutcome) => void) | undefined;
  try {
    observer?.stage("dedupe_wait", "dedupe_owner");
    finish = observer?.begin({ kind: "dedupe" }).finish;
  } catch {
    // Observability must not affect dedupe ownership or retry policy.
  }
  try {
    const result = await pending;
    try {
      finish?.("completed");
    } catch {
      // Observability must not affect dedupe ownership or retry policy.
    }
    return result;
  } catch (error) {
    try {
      finish?.("failed");
    } catch {
      // Observability must not affect dedupe ownership or retry policy.
    }
    throw error;
  }
}

export function createChannelIngressLifecycleObserver(params: {
  now: () => number;
  record: (update: ChannelIngressProgressUpdate) => Promise<boolean> | boolean;
  context?: Omit<ChannelIngressActiveOperationSnapshot, "id" | "kind" | "startedAt">;
  onError?: (error: unknown) => void;
}): ChannelIngressObserverController {
  const activeOperations = new Map<string, ChannelIngressActiveOperationSnapshot>();
  const overflowByKind = new Map<ChannelIngressOperationKind, number>();
  let closed = false;
  let recordFailed = false;
  let operationSequence = 0;
  const incrementOverflow = (kind: ChannelIngressOperationKind): void => {
    overflowByKind.set(kind, (overflowByKind.get(kind) ?? 0) + 1);
  };
  const decrementOverflow = (kind: ChannelIngressOperationKind): void => {
    const next = (overflowByKind.get(kind) ?? 0) - 1;
    if (next > 0) {
      overflowByKind.set(kind, next);
    } else {
      overflowByKind.delete(kind);
    }
  };
  const failObservation = (): void => {
    activeOperations.clear();
    overflowByKind.clear();
    recordFailed = true;
    closed = true;
  };
  const record = (update: ChannelIngressProgressUpdate): void => {
    if (closed) {
      return;
    }
    Promise.resolve()
      .then(() => params.record(update))
      .then((committed) => {
        if (!committed) {
          failObservation();
        }
      })
      .catch((error: unknown) => {
        failObservation();
        try {
          params.onError?.(error);
        } catch {
          // Observability must not corrupt ingress lifecycle ownership.
        }
      });
  };
  return {
    stage: (stage, blocker = "none") => {
      const observedAt = params.now();
      record({ stage, blocker, stageStartedAt: observedAt, observedAt });
    },
    progress: (stage, blocker) => {
      const observedAt = params.now();
      record({
        ...(stage ? { stage } : {}),
        ...(blocker ? { blocker } : {}),
        progressAt: observedAt,
        observedAt,
      });
    },
    correlate: (correlation) => record({ correlation, observedAt: params.now() }),
    begin: (operation) => {
      if (closed) {
        return { finish: () => {} };
      }
      const startedAt = params.now();
      const id = `${operation.kind}:${startedAt}:${operationSequence++}`;
      const overflowed = activeOperations.size >= MAX_ACTIVE_OPERATIONS;
      if (overflowed) {
        incrementOverflow(operation.kind);
      } else {
        activeOperations.set(id, {
          id,
          kind: operation.kind,
          startedAt,
          ...(boundedString(operation.method) ? { method: boundedString(operation.method) } : {}),
          ...(boundedString(operation.profile)
            ? { profile: boundedString(operation.profile) }
            : {}),
          ...params.context,
        });
      }
      record({
        operation: { ...operation, id, startedAt, phase: "begin" },
        observedAt: startedAt,
      });
      let finished = false;
      return {
        finish: (outcome = "completed") => {
          if (finished || closed) {
            return;
          }
          finished = true;
          const finishedAt = params.now();
          if (overflowed) {
            decrementOverflow(operation.kind);
          } else {
            activeOperations.delete(id);
          }
          record({
            operation: { phase: "finish", id, outcome, finishedAt },
            observedAt: finishedAt,
          });
        },
      };
    },
    getActiveOperations: () => (closed ? [] : [...activeOperations.values()]),
    getActiveOperationSnapshot: () => {
      if (closed && !recordFailed) {
        return { operations: [] };
      }
      const overflowByKindObject: NonNullable<
        ChannelIngressActiveOperationsSnapshot["overflowByKind"]
      > = {};
      for (const [kind, count] of overflowByKind.entries()) {
        overflowByKindObject[kind] = count;
      }
      const unknownProgressEvent: ChannelIngressObservationRecordRef | undefined = params.context
        ?.eventId
        ? {
            eventId: params.context.eventId,
            ...(params.context.queueName ? { queueName: params.context.queueName } : {}),
            ...(params.context.channelId ? { channelId: params.context.channelId } : {}),
            ...(params.context.accountId ? { accountId: params.context.accountId } : {}),
          }
        : undefined;
      const snapshot: ChannelIngressActiveOperationsSnapshot = {
        operations: closed ? [] : [...activeOperations.values()],
      };
      if (Object.keys(overflowByKindObject).length > 0) {
        snapshot.overflowByKind = overflowByKindObject;
      }
      if (recordFailed && unknownProgressEvent) {
        snapshot.unknownProgressEvents = [unknownProgressEvent];
      }
      return snapshot;
    },
    revoke: () => {
      activeOperations.clear();
      overflowByKind.clear();
      recordFailed = false;
      closed = true;
    },
  };
}
