/**
 * Durable inbound receive journal.
 *
 * Tracks accepted, pending, completed, and retryable inbound platform events.
 */
import type { ChannelIngressQueue, ChannelIngressQueuePruneOptions } from "./ingress-queue.js";

/** Pending inbound receive record kept until agent dispatch or durable send completes. */
type DurableInboundReceivePendingRecord<TPayload, TMetadata = unknown> = {
  id: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

/** Completed inbound receive tombstone used to detect duplicate platform events. */
type DurableInboundReceiveCompletedRecord<TMetadata = unknown> = {
  id: string;
  completedAt: number;
  metadata?: TMetadata;
};

/** Terminal failed inbound receive tombstone used to suppress unsafe replay. */
export type DurableInboundReceiveFailedRecord = {
  id: string;
  failedAt: number;
  reason: string;
  message?: string;
};

/** Accept result for a new or duplicate inbound platform event. */
type DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata> =
  | {
      kind: "accepted";
      duplicate: false;
      record: DurableInboundReceivePendingRecord<TPayload, TMetadata>;
    }
  | {
      kind: "pending";
      duplicate: true;
      record: DurableInboundReceivePendingRecord<TPayload, TMetadata>;
    }
  | {
      kind: "completed";
      duplicate: true;
      record: DurableInboundReceiveCompletedRecord<TCompletedMetadata>;
    }
  | {
      kind: "failed";
      duplicate: true;
      record: DurableInboundReceiveFailedRecord;
    };

/** Options recorded when accepting a pending inbound event. */
type DurableInboundReceiveAcceptOptions<TMetadata> = {
  metadata?: TMetadata;
  receivedAt?: number;
};

/** Options recorded when marking an inbound event complete. */
type DurableInboundReceiveCompleteOptions<TCompletedMetadata> = {
  metadata?: TCompletedMetadata;
  completedAt?: number;
};

/** Options recorded when releasing an inbound event for retry. */
type DurableInboundReceiveReleaseOptions = {
  lastError?: string;
  releasedAt?: number;
};

/** Durable receive journal facade used by channel receive pipelines. */
type DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> = {
  accept(
    id: string,
    payload: TPayload,
    options?: DurableInboundReceiveAcceptOptions<TMetadata>,
  ): Promise<DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata>>;
  pending(): Promise<Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>>;
  complete(
    id: string,
    options?: DurableInboundReceiveCompleteOptions<TCompletedMetadata>,
  ): Promise<void>;
  release(id: string, options?: DurableInboundReceiveReleaseOptions): Promise<boolean>;
  deletePending(id: string): Promise<boolean>;
};

/** Queue-backed durable receive journal options with independent retention and admission policy. */
export type DurableInboundReceiveQueueJournalOptions<TPayload, TMetadata, TCompletedMetadata> = {
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  retention?: ChannelIngressQueuePruneOptions;
  /** Reject new ids at this bound without changing retention behavior for existing callers. */
  admission?: { pendingMaxEntries?: number };
};

/** Raised when durable ingress cannot admit a new id without evicting accepted pending work. */
class DurableInboundReceiveCapacityError extends Error {
  readonly maxPendingEntries: number;

  constructor(maxPendingEntries: number) {
    super(`Durable inbound receive queue is full (${maxPendingEntries} pending entries)`);
    this.name = "DurableInboundReceiveCapacityError";
    this.maxPendingEntries = maxPendingEntries;
  }
}

/** Identify durable receive admission failures without exposing the internal error class. */
export function isDurableInboundReceiveCapacityError(
  error: unknown,
): error is Error & { readonly maxPendingEntries: number } {
  return error instanceof DurableInboundReceiveCapacityError;
}

function normalizeDurableInboundReceiveId(id: string): string {
  const normalized = id.trim();
  if (!normalized) {
    throw new Error("Durable inbound receive id cannot be empty");
  }
  return normalized;
}

/** Adapts the shared channel ingress queue to the durable receive journal API. */
export function createDurableInboundReceiveJournalFromQueue<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: DurableInboundReceiveQueueJournalOptions<TPayload, TMetadata, TCompletedMetadata>,
): DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> {
  const prune = async (protectId?: string) => {
    if (options.retention) {
      await options.queue.prune({
        ...options.retention,
        ...(protectId === undefined ? {} : { protectIds: [protectId] }),
      });
    }
  };
  return {
    accept: async (id, payload, acceptOptions) => {
      await prune();
      const result = await options.queue.enqueue(normalizeDurableInboundReceiveId(id), payload, {
        ...(acceptOptions?.metadata === undefined ? {} : { metadata: acceptOptions.metadata }),
        ...(acceptOptions?.receivedAt === undefined
          ? {}
          : { receivedAt: acceptOptions.receivedAt }),
        ...(options.admission?.pendingMaxEntries === undefined
          ? {}
          : { maxPendingEntries: options.admission.pendingMaxEntries }),
      });
      if (result.kind === "capacity") {
        throw new DurableInboundReceiveCapacityError(result.maxPendingEntries);
      }
      await prune(normalizeDurableInboundReceiveId(id));
      if (result.kind === "accepted") {
        return { kind: "accepted", duplicate: false, record: result.record };
      }
      if (result.kind === "completed") {
        return { kind: "completed", duplicate: true, record: result.record };
      }
      if (result.kind === "pending" || result.kind === "claimed") {
        return { kind: "pending", duplicate: true, record: result.record };
      }
      // Queue failures represent terminal corruption or an owner-level fail decision. Preserve
      // that state so callers do not mistake a failed event for a successfully completed one.
      return {
        kind: "failed",
        duplicate: true,
        record: {
          id: result.record.id,
          failedAt: result.record.failedAt,
          reason: result.record.reason,
          ...(result.record.message === undefined ? {} : { message: result.record.message }),
        },
      };
    },
    pending: async () => {
      await prune();
      return await options.queue.listPending({ limit: "all" });
    },
    complete: async (id, completeOptions) => {
      await options.queue.complete(normalizeDurableInboundReceiveId(id), {
        ...(completeOptions?.metadata === undefined ? {} : { metadata: completeOptions.metadata }),
        ...(completeOptions?.completedAt === undefined
          ? {}
          : { completedAt: completeOptions.completedAt }),
      });
      await prune(normalizeDurableInboundReceiveId(id));
    },
    release: async (id, releaseOptions) => {
      const released = await options.queue.release(normalizeDurableInboundReceiveId(id), {
        ...(releaseOptions?.lastError === undefined ? {} : { lastError: releaseOptions.lastError }),
        ...(releaseOptions?.releasedAt === undefined
          ? {}
          : { releasedAt: releaseOptions.releasedAt }),
      });
      await prune(normalizeDurableInboundReceiveId(id));
      return released;
    },
    deletePending: async (id) => {
      const deleted = await options.queue.delete(normalizeDurableInboundReceiveId(id));
      await prune();
      return deleted;
    },
  };
}
