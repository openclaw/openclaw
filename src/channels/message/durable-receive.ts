import type { PluginStateKeyedStore } from "../../plugin-state/plugin-state-store.types.js";
import type { ChannelIngressQueue, ChannelIngressQueuePruneOptions } from "./ingress-queue.js";

export type DurableInboundReceivePendingRecord<TPayload, TMetadata = unknown> = {
  id: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

export type DurableInboundReceiveCompletedRecord<TMetadata = unknown> = {
  id: string;
  completedAt: number;
  metadata?: TMetadata;
};

export type DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata> =
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
    };

export type DurableInboundReceiveJournalOptions<TPayload, TMetadata, TCompletedMetadata> = {
  pendingStore: PluginStateKeyedStore<DurableInboundReceivePendingRecord<TPayload, TMetadata>>;
  completedStore: PluginStateKeyedStore<DurableInboundReceiveCompletedRecord<TCompletedMetadata>>;
  now?: () => number;
  pendingTtlMs?: number;
  completedTtlMs?: number;
};

export type DurableInboundReceiveAcceptOptions<TMetadata> = {
  metadata?: TMetadata;
  receivedAt?: number;
};

export type DurableInboundReceiveCompleteOptions<TCompletedMetadata> = {
  metadata?: TCompletedMetadata;
  completedAt?: number;
};

export type DurableInboundReceiveReleaseOptions = {
  lastError?: string;
  releasedAt?: number;
};

export type DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> = {
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

export type DurableInboundReceiveQueueJournalOptions<TPayload, TMetadata, TCompletedMetadata> = {
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  retention?: ChannelIngressQueuePruneOptions;
};

function normalizeDurableInboundReceiveId(id: string): string {
  const normalized = id.trim();
  if (!normalized) {
    throw new Error("Durable inbound receive id cannot be empty");
  }
  return normalized;
}

function sortPendingRecords<TPayload, TMetadata>(
  records: Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>,
): Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>> {
  return records.toSorted((a, b) => a.receivedAt - b.receivedAt || a.id.localeCompare(b.id));
}

export function createDurableInboundReceiveJournal<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: DurableInboundReceiveJournalOptions<TPayload, TMetadata, TCompletedMetadata>,
): DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> {
  const now = options.now ?? Date.now;

  const accept = async (
    id: string,
    payload: TPayload,
    acceptOptions?: DurableInboundReceiveAcceptOptions<TMetadata>,
  ): Promise<DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata>> => {
    const key = normalizeDurableInboundReceiveId(id);
    const completed = await options.completedStore.lookup(key);
    if (completed) {
      return { kind: "completed", duplicate: true, record: completed };
    }

    const receivedAt = acceptOptions?.receivedAt ?? now();
    const record: DurableInboundReceivePendingRecord<TPayload, TMetadata> = {
      id: key,
      payload,
      receivedAt,
      updatedAt: receivedAt,
      attempts: 0,
    };
    if (acceptOptions?.metadata !== undefined) {
      record.metadata = acceptOptions.metadata;
    }

    const acceptInsertedRecord = async (): Promise<
      DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata>
    > => {
      const completedAfterInsertRace = await options.completedStore.lookup(key);
      if (completedAfterInsertRace) {
        await options.pendingStore.delete(key);
        return { kind: "completed", duplicate: true, record: completedAfterInsertRace };
      }
      return { kind: "accepted", duplicate: false, record };
    };

    const inserted = await options.pendingStore.registerIfAbsent(key, record, {
      ttlMs: options.pendingTtlMs,
    });
    if (inserted) {
      return acceptInsertedRecord();
    }

    const pending = await options.pendingStore.lookup(key);
    if (pending) {
      return { kind: "pending", duplicate: true, record: pending };
    }

    const completedAfterPendingRace = await options.completedStore.lookup(key);
    if (completedAfterPendingRace) {
      return { kind: "completed", duplicate: true, record: completedAfterPendingRace };
    }

    const retryInserted = await options.pendingStore.registerIfAbsent(key, record, {
      ttlMs: options.pendingTtlMs,
    });
    if (retryInserted) {
      return acceptInsertedRecord();
    }
    return {
      kind: "pending",
      duplicate: true,
      record: (await options.pendingStore.lookup(key)) ?? record,
    };
  };

  const pending = async (): Promise<
    Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>
  > => {
    const entries = await options.pendingStore.entries();
    const records: Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>> = [];
    for (const entry of entries) {
      if (await options.completedStore.lookup(entry.key)) {
        await options.pendingStore.delete(entry.key);
        continue;
      }
      records.push(entry.value);
    }
    return sortPendingRecords(records);
  };

  const complete = async (
    id: string,
    completeOptions?: DurableInboundReceiveCompleteOptions<TCompletedMetadata>,
  ): Promise<void> => {
    const key = normalizeDurableInboundReceiveId(id);
    const completedAt = completeOptions?.completedAt ?? now();
    const record: DurableInboundReceiveCompletedRecord<TCompletedMetadata> = {
      id: key,
      completedAt,
    };
    if (completeOptions?.metadata !== undefined) {
      record.metadata = completeOptions.metadata;
    }
    await options.completedStore.register(key, record, { ttlMs: options.completedTtlMs });
    await options.pendingStore.delete(key);
  };

  const release = async (
    id: string,
    releaseOptions?: DurableInboundReceiveReleaseOptions,
  ): Promise<boolean> => {
    const key = normalizeDurableInboundReceiveId(id);
    const record = await options.pendingStore.lookup(key);
    if (!record) {
      return false;
    }
    const releasedAt = releaseOptions?.releasedAt ?? now();
    const updated: DurableInboundReceivePendingRecord<TPayload, TMetadata> = {
      ...record,
      updatedAt: releasedAt,
      attempts: record.attempts + 1,
      lastAttemptAt: releasedAt,
    };
    if (releaseOptions?.lastError !== undefined) {
      updated.lastError = releaseOptions.lastError;
    }
    await options.pendingStore.register(key, updated, { ttlMs: options.pendingTtlMs });
    return true;
  };

  return {
    accept,
    pending,
    complete,
    release,
    deletePending: (id) => options.pendingStore.delete(normalizeDurableInboundReceiveId(id)),
  };
}

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
      });
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
      return {
        kind: "pending",
        duplicate: true,
        record: {
          id: result.record.id,
          payload,
          receivedAt: result.record.failedAt,
          updatedAt: result.record.failedAt,
          attempts: 0,
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
