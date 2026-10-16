import type { ChannelIngressQueue, ChannelIngressQueuePruneOptions } from "./ingress-queue.js";
import type {
  ChannelIngressQueueCompletedRecord,
  ChannelIngressQueueRecord,
} from "./ingress-queue.types.js";

/** Pending inbound receive record kept until agent dispatch or durable send completes. */
type DurableInboundReceivePendingRecord<TPayload, TMetadata = unknown> = Omit<
  ChannelIngressQueueRecord<TPayload, TMetadata>,
  "channelId" | "accountId" | "queueName" | "laneKey"
>;

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
      record: Pick<
        ChannelIngressQueueCompletedRecord<TCompletedMetadata>,
        "id" | "completedAt" | "metadata"
      >;
    };

type DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> = {
  accept(
    id: string,
    payload: TPayload,
    options?: { metadata?: TMetadata; receivedAt?: number },
  ): Promise<DurableInboundReceiveAcceptResult<TPayload, TMetadata, TCompletedMetadata>>;
  pending(): Promise<Array<DurableInboundReceivePendingRecord<TPayload, TMetadata>>>;
  complete(
    id: string,
    options?: { metadata?: TCompletedMetadata; completedAt?: number },
  ): Promise<void>;
  release(id: string, options?: { lastError?: string; releasedAt?: number }): Promise<boolean>;
  deletePending(id: string): Promise<boolean>;
};

function normalizeDurableInboundReceiveId(id: string): string {
  const normalized = id.trim();
  if (!normalized) {
    throw new Error("Durable inbound receive id cannot be empty");
  }
  return normalized;
}

export function createDurableInboundReceiveJournalFromQueue<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(options: {
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
  retention?: ChannelIngressQueuePruneOptions;
}): DurableInboundReceiveJournal<TPayload, TMetadata, TCompletedMetadata> {
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
      const eventId = normalizeDurableInboundReceiveId(id);
      const result = await options.queue.enqueue(eventId, payload, {
        ...(acceptOptions?.metadata === undefined ? {} : { metadata: acceptOptions.metadata }),
        ...(acceptOptions?.receivedAt === undefined
          ? {}
          : { receivedAt: acceptOptions.receivedAt }),
      });
      await prune(eventId);
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
