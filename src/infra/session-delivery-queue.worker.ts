import { computeBackoff } from "../../packages/retry/src/index.js";
import {
  admitSubagentCompletionInWorker,
  mutateSubagentCompletionInWorker,
} from "../agents/subagents/completion/subagent-completion-admission.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  type bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueStoredStatus } from "./delivery-queue-sqlite.kernel.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import type { SessionDeliveryAgentRunUpdate } from "./session-delivery-queue.worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

function readSessionDelivery(
  database: OpenClawStateDatabase,
  id: string,
): QueuedSessionDelivery | null {
  const entry = loadDeliveryQueueEntryInDatabase(
    database,
    SESSION_DELIVERY_QUEUE_NAME,
    id,
    "pending",
  );
  // SAFETY: The session namespace retains the canonical session-delivery payload contract.
  return entry as QueuedSessionDelivery | null;
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
  "sessionDelivery.enqueue": (input: PreparedEntry, { open }) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        upsertBoundDeliveryQueueEntryInDatabase(input, database);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "sessionDelivery.enqueue" },
    );
  },
  "sessionDelivery.enqueueClaimed": (input: PreparedEntry, { open }) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      () => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const id = input.row.id;
        const claimed = upsertBoundDeliveryQueueEntryInDatabase(input, database);
        let status: DeliveryQueueStoredStatus;
        try {
          status = claimed ? "pending" : (readStatus(database, id) ?? "completed");
        } catch {
          status = "unknown";
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return { id, claimed, status };
      },
      { database, path: database.path, env: getSqliteWorkerStateContext().environment },
      { operationLabel: "sessionDelivery.enqueueClaimed" },
    );
  },
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
  "sessionDelivery.advanceAgentRun": (
    input: { id: string; updates?: SessionDeliveryAgentRunUpdate },
    { open },
  ) => {
    const database = open();
    const { id, updates } = input;
    update(database, id, (entry) =>
      entry.kind !== "agentTurn"
        ? entry
        : {
            ...entry,
            agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
            deliveryStartedAt: undefined,
            ...(updates?.message ? { message: updates.message } : {}),
            ...(updates?.expectedMediaUrls ? { expectedMediaUrls: updates.expectedMediaUrls } : {}),
            ...(updates?.suppressTextDelivery === true
              ? { suppressTextDelivery: true as const }
              : {}),
          },
    );
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
      const retryCount = entry.retryCount + 1;
      const now = Date.now();
      return {
        ...entry,
        retryCount,
        ...(entry.kind === "agentTurn"
          ? { lastChargedAgentRunAttempt: entry.agentRunAttempt ?? 0 }
          : {}),
        ...(releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
        lastAttemptAt: now,
        ...(entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion"
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
  "sessionDelivery.load": (input: { id: string }, { open }) =>
    readSessionDelivery(open(), input.id),
  "sessionDelivery.list": (_input: undefined, { open }) => {
    const database = open();
    const entries = loadDeliveryQueueEntriesInDatabase(database, SESSION_DELIVERY_QUEUE_NAME);
    // SAFETY: All returned rows belong to the canonical session-delivery namespace.
    return entries as QueuedSessionDelivery[];
  },
  "sessionDelivery.moveToFailed": (input: { id: string }, { open }) => {
    const database = open();
    const { id } = input;
    return finalize(database, id, "failed", () => {
      const entry = readSessionDelivery(database, id);
      if (!entry) {
        throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
      }
      const result = terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepareDeliveryQueueTerminalEntry({ queueName: SESSION_DELIVERY_QUEUE_NAME, id, entry }),
      );
      if (result.status !== "terminalized") {
        throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
      }
    });
  },
} satisfies WorkerOperationHandlers;

export type SessionDeliveryWorkerOperations = WorkerOperations<typeof sessionDeliveryOperations>;
