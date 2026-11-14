import { computeBackoff } from "../../packages/retry/src/index.js";
import type { subagentCompletionDeliveryOperations } from "../agents/subagents/completion/subagent-completion-admission.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
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
  type SessionDeliveryCandidateMedia,
} from "./session-delivery-queue.records.js";

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
  "sessionDelivery.enqueue": (input: PreparedEntry, { writeAdmitted }) =>
    writeAdmitted(
      (database) => {
        upsertBoundDeliveryQueueEntryInDatabase(input, database);
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
    const current = readSessionDelivery(database, input.row.id);
    if (current?.kind === "mediaCandidate") {
      throw new Error("Generated media is held for review or superseded");
    }
    if (!upsertBoundDeliveryQueueEntryInDatabase(input, database)) {
      throw new Error(`Session delivery ${input.row.id} is no longer pending`);
    }
  },
  "sessionDelivery.setMediaReview": (
    input: {
      id: string;
      sessionKey: string;
      taskId: string;
      disposition: "approved" | "superseded";
      media?: SessionDeliveryCandidateMedia;
    },
    { open },
  ): "approved" | "superseded" | "delivery_started" | "not_found" | "not_review_pending" => {
    const database = open();
    const entry = readSessionDelivery(database, input.id);
    if (
      !entry ||
      entry.kind === "systemEvent" ||
      entry.sessionKey !== input.sessionKey ||
      (entry.kind === "mediaCandidate" && entry.taskId !== input.taskId)
    ) {
      return "not_found";
    }
    if (
      entry.deliveryStartedAt !== undefined ||
      entry.acknowledgedAt !== undefined ||
      entry.settlementOutcome
    ) {
      return "delivery_started";
    }
    if (entry.kind === "mediaCandidate" && entry.disposition === "superseded") {
      return "superseded";
    }
    if (
      input.disposition === "approved" &&
      entry.kind !== "mediaCandidate" &&
      entry.reviewedTaskId !== input.taskId
    ) {
      return "not_review_pending";
    }
    update(database, input.id, (current) => {
      if (current.kind === "systemEvent") {
        return current;
      }
      if (input.disposition === "approved") {
        if (current.kind === "agentTurn") {
          return current;
        }
        const {
          taskId,
          disposition: _disposition,
          inspectionContext: _inspectionContext,
          ...payload
        } = current;
        return { ...payload, kind: "agentTurn", reviewedTaskId: taskId, availableAt: Date.now() };
      }
      return {
        ...current,
        ...input.media,
        ...(input.media ? { preparedMediaBlocks: undefined } : {}),
        kind: "mediaCandidate",
        taskId: input.taskId,
        disposition: "superseded",
        availableAt: Date.now(),
      };
    });
    return input.disposition;
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
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type SessionDeliveryWorkerOperations = WorkerOperations<typeof sessionDeliveryOperations> &
  WorkerOperations<typeof subagentCompletionDeliveryOperations>;
