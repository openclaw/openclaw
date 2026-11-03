import { computeBackoff } from "../../packages/retry/src/index.js";
import {
  admitSubagentCompletionInWorker,
  mutateSubagentCompletionInWorker,
} from "../agents/subagents/completion/subagent-completion-admission.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  type bindDeliveryQueueEntry,
  deliveryQueueEntriesQuery,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  type DeliveryQueueEntryLoadResult,
  inflateDeliveryQueueEntryResult,
} from "./delivery-queue-sqlite-codec.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizeInvalidDeliveryQueueEntryInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueStoredStatus } from "./delivery-queue-sqlite.kernel.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import {
  hasOnlyGenericAttachmentRefs,
  scrubTerminalQueuedAttachments,
} from "./session-delivery-queue-attachment-metadata.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";

function readSessionDeliveryResult(
  database: OpenClawStateDatabase,
  id: string,
): DeliveryQueueEntryLoadResult | null {
  const query = deliveryQueueEntriesQuery(database, [SESSION_DELIVERY_QUEUE_NAME], "pending").where(
    "id",
    "=",
    id,
  );
  const row = executeSqliteQueryTakeFirstSync(database.db, query);
  return row ? inflateDeliveryQueueEntryResult(row) : null;
}

function readStatus(database: OpenClawStateDatabase, id: string) {
  return getDeliveryQueueEntryOwnersInDatabase(database, [SESSION_DELIVERY_QUEUE_NAME], id).get(
    SESSION_DELIVERY_QUEUE_NAME,
  )?.status;
}

function update(
  database: OpenClawStateDatabase,
  id: string,
  transform: (entry: QueuedSessionDelivery) => QueuedSessionDelivery,
) {
  return updateDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id, (entry) =>
    // SAFETY: Only the session namespace reaches this payload transform.
    transform(entry as QueuedSessionDelivery),
  );
}

function finalize(
  database: OpenClawStateDatabase,
  id: string,
  status: "completed" | "failed",
  transition: () => void,
) {
  try {
    transition();
  } catch (error) {
    try {
      if (readStatus(database, id) === status) {
        return;
      }
    } catch {
      // Preserve the transition failure when durable settlement cannot be established.
    }
    throw error;
  }
}

type PreparedEntry = ReturnType<typeof bindDeliveryQueueEntry>;
type PreparedMediaResult =
  | { source: "input" }
  | { source: "stored"; blocks: Array<Record<string, unknown>> };

export const sessionDeliveryOperations = {
  "sessionDelivery.mutateSubagentCompletion": (
    input: Parameters<typeof mutateSubagentCompletionInWorker>[0],
    { open },
  ) => mutateSubagentCompletionInWorker(input, open()),
  "sessionDelivery.admitSubagentCompletion": (
    input: Parameters<typeof admitSubagentCompletionInWorker>[0],
    { open },
  ) => admitSubagentCompletionInWorker(input, open()),
  // Stored status is a string column; "unknown" means the row could not be read back.
  "sessionDelivery.enqueue": (
    input: PreparedEntry,
    { writeAdmitted },
  ): { status: DeliveryQueueStoredStatus } =>
    writeAdmitted(
      (database) => {
        const id = input.row.id;
        upsertBoundDeliveryQueueEntryInDatabase(input, database);
        // Read the settled status here so enqueue callers never touch SQLite on the main thread.
        let enqueuedStatus: DeliveryQueueStoredStatus;
        try {
          enqueuedStatus = readStatus(database, id) ?? "unknown";
        } catch {
          enqueuedStatus = "unknown";
        }
        return { status: enqueuedStatus };
      },
      { operationLabel: "sessionDelivery.enqueue" },
    ),
  "sessionDelivery.enqueueClaimed": (input: PreparedEntry, { writeAdmitted }) =>
    writeAdmitted(
      (database) => {
        const id = input.row.id;
        const claimed = upsertBoundDeliveryQueueEntryInDatabase(input, database);
        let status: DeliveryQueueStoredStatus;
        try {
          status = claimed ? "pending" : (readStatus(database, id) ?? "completed");
        } catch {
          status = "unknown";
        }
        return { id, claimed, status };
      },
      { operationLabel: "sessionDelivery.enqueueClaimed" },
    ),
  "sessionDelivery.releaseClaim": (input: { id: string }, { open }) => {
    const database = open();
    update(database, input.id, (entry) => ({ ...entry, availableAt: Date.now() }));
  },
  "sessionDelivery.defer": (input: { id: string; delayMs: number }, { open }) => {
    const database = open();
    const { id, delayMs } = input;
    update(database, id, (entry) => ({
      ...entry,
      availableAt: Date.now() + Math.max(0, delayMs),
    }));
  },
  "sessionDelivery.mergePreparedMedia": (
    input: { id: string; mediaUrl: string; blocksJson: string },
    { open },
  ): PreparedMediaResult => {
    const database = open();
    const { id, mediaUrl, blocksJson } = input;
    let result: PreparedMediaResult = {
      source: "input",
    };
    update(database, id, (entry) => {
      if (entry.kind !== "agentTurn") {
        return entry;
      }
      const stored = entry.preparedMediaBlocks?.[mediaUrl];
      // SAFETY: The host serialized the caller's typed block array before worker admission.
      const blocks = stored ?? (JSON.parse(blocksJson) as Array<Record<string, unknown>>);
      if (stored != null) {
        result = { source: "stored", blocks: stored };
      }
      return {
        ...entry,
        preparedMediaBlocks: { ...entry.preparedMediaBlocks, [mediaUrl]: blocks },
      };
    });
    return result;
  },
  "sessionDelivery.markAttemptStarted": (input: PreparedEntry, { open }) => {
    const database = open();
    if (!upsertBoundDeliveryQueueEntryInDatabase(input, database)) {
      throw new Error(`Session delivery ${input.row.id} is no longer pending`);
    }
  },
  "sessionDelivery.markSettlement": (input: PreparedEntry, { open }) => {
    const database = open();
    const id = input.row.id;
    return finalize(database, id, "completed", () => {
      if (
        upsertBoundDeliveryQueueEntryInDatabase(input, database) ||
        readStatus(database, id) === "completed"
      ) {
        return;
      }
      throw new Error(`Session delivery ${id} is no longer pending`);
    });
  },
  "sessionDelivery.complete": (input: { id: string }, { open }) => {
    const database = open();
    const { id } = input;
    return finalize(database, id, "completed", () => {
      completeDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id);
    });
  },
  "sessionDelivery.fail": (
    input: { id: string; error: string; releaseAttemptOwnership?: boolean },
    { open },
  ) => {
    const database = open();
    const { id, error, releaseAttemptOwnership } = input;
    update(database, id, (entry) => {
      const safeEntry =
        entry.kind === "postCompactionDelegate" || hasOnlyGenericAttachmentRefs(entry)
          ? entry
          : scrubTerminalQueuedAttachments(entry);
      const retryCount = safeEntry.retryCount + 1;
      const now = Date.now();
      return {
        ...safeEntry,
        retryCount,
        ...(releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
        lastAttemptAt: now,
        ...(safeEntry.kind === "agentTurn" && safeEntry.owner?.kind === "subagent_completion"
          ? {
              availableAt:
                now +
                computeBackoff(
                  { initialMs: 15_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 },
                  retryCount,
                ),
            }
          : {}),
        lastError: error,
      };
    });
  },
  "sessionDelivery.failInvalid": (
    input: {
      entry: { id: string; enqueuedAt: number; retryCount: number };
      error: string;
      entryJson: string;
    },
    { open },
  ): void => {
    const { entry, error, entryJson } = input;
    terminalizeInvalidDeliveryQueueEntryInDatabase(open(), {
      queueName: SESSION_DELIVERY_QUEUE_NAME,
      id: entry.id,
      lastError: error,
      entry: {
        id: entry.id,
        enqueuedAt: entry.enqueuedAt,
        retryCount: entry.retryCount,
        retainOnFailure: true,
      },
      expectedEntryJson: entryJson,
    });
  },
  "sessionDelivery.load": (input: { id: string }, { open }) =>
    readSessionDeliveryResult(open(), input.id),
  "sessionDelivery.list": (_input: undefined, { open }): DeliveryQueueEntryLoadResult[] => {
    const database = open();
    return executeSqliteQuerySync(
      database.db,
      deliveryQueueEntriesQuery(database, [SESSION_DELIVERY_QUEUE_NAME], "pending")
        .orderBy("enqueued_at", "asc")
        .orderBy("id", "asc"),
    ).rows.map(inflateDeliveryQueueEntryResult);
  },
  "sessionDelivery.moveToFailed": (input: { id: string; keepFailedReceipt?: true }, { open }) => {
    const database = open();
    const { id, keepFailedReceipt } = input;
    return finalize(database, id, "failed", () => {
      const result = readSessionDeliveryResult(database, id);
      if (result?.status !== "loaded") {
        throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
      }
      const entry = result.entry;
      const terminalized = terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepareDeliveryQueueTerminalEntry({
          queueName: SESSION_DELIVERY_QUEUE_NAME,
          id,
          entry,
          keepFailedReceipt,
        }),
      );
      if (terminalized.status !== "terminalized") {
        throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
      }
    });
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type SessionDeliveryWorkerOperations = WorkerOperations<typeof sessionDeliveryOperations>;
