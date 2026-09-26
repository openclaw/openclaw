import { computeBackoff } from "../../packages/retry/src/index.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
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
import {
  SESSION_DELIVERY_QUEUE_NAME,
  NATIVE_CHILD_DELIVERY_QUEUE_NAME,
  resolveSessionDeliveryQueueName,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "./session-delivery-queue.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

function readSessionDelivery(
  database: OpenClawStateDatabase,
  id: string,
): QueuedSessionDelivery | null {
  const entry = loadDeliveryQueueEntryInDatabase(
    database,
    resolveSessionDeliveryQueueName(id),
    id,
    "pending",
  );
  // SAFETY: The session namespace retains the canonical session-delivery payload contract.
  return entry as QueuedSessionDelivery | null;
}

export function executeSessionDeliveryCommand(
  command: SqliteWorkerCommand<SessionDeliveryWorkerOperations>,
  database: OpenClawStateDatabase,
): SessionDeliveryWorkerOperations[keyof SessionDeliveryWorkerOperations]["output"] {
  const readStatus = (id: string) =>
    getDeliveryQueueEntryOwnersInDatabase(database, [resolveSessionDeliveryQueueName(id)], id).get(
      resolveSessionDeliveryQueueName(id),
    )?.status;
  const update = (id: string, transform: (entry: QueuedSessionDelivery) => QueuedSessionDelivery) =>
    updateDeliveryQueueEntryInDatabase(database, resolveSessionDeliveryQueueName(id), id, (entry) =>
      // SAFETY: Only the session namespace reaches this payload transform.
      transform(entry as QueuedSessionDelivery),
    );
  const finalize = (id: string, status: "completed" | "failed", transition: () => void) => {
    try {
      transition();
    } catch (error) {
      try {
        if (readStatus(id) === status) {
          return;
        }
      } catch {
        // Preserve the transition failure when durable settlement cannot be established.
      }
      throw error;
    }
  };

  switch (command.type) {
    case "sessionDelivery.enqueue":
      upsertBoundDeliveryQueueEntryInDatabase(command.input, database);
      return;
    case "sessionDelivery.enqueueClaimed": {
      const id = command.input.row.id;
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(command.input, database);
      try {
        return { id, claimed, status: claimed ? "pending" : (readStatus(id) ?? "completed") };
      } catch {
        // A failed status read cannot undo the ownership established by the insert conflict.
        return { id, claimed, status: "unknown" };
      }
    }
    case "sessionDelivery.releaseClaim":
      update(command.input.id, (entry) => ({ ...entry, availableAt: Date.now() }));
      return;
    case "sessionDelivery.defer": {
      const { id, delayMs } = command.input;
      update(id, (entry) => ({
        ...entry,
        availableAt: Date.now() + Math.max(0, delayMs),
      }));
      return;
    }
    case "sessionDelivery.advanceAgentRun": {
      const { id, updates } = command.input;
      update(id, (entry) =>
        entry.kind !== "agentTurn"
          ? entry
          : {
              ...entry,
              agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
              deliveryStartedAt: undefined,
              ...(updates?.message ? { message: updates.message } : {}),
              ...(updates?.expectedMediaUrls
                ? { expectedMediaUrls: updates.expectedMediaUrls }
                : {}),
              ...(updates?.suppressTextDelivery === true
                ? { suppressTextDelivery: true as const }
                : {}),
            },
      );
      return;
    }
    case "sessionDelivery.mergePreparedMedia": {
      const { id, mediaUrl, blocksJson } = command.input;
      let result: SessionDeliveryWorkerOperations["sessionDelivery.mergePreparedMedia"]["output"] =
        {
          source: "input",
        };
      update(id, (entry) => {
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
    }
    case "sessionDelivery.markAttemptStarted": {
      if (!upsertBoundDeliveryQueueEntryInDatabase(command.input, database)) {
        throw new Error(`Session delivery ${command.input.row.id} is no longer pending`);
      }
      return;
    }
    case "sessionDelivery.markSettlement": {
      const id = command.input.row.id;
      return finalize(id, "completed", () => {
        if (
          upsertBoundDeliveryQueueEntryInDatabase(command.input, database) ||
          readStatus(id) === "completed"
        ) {
          return;
        }
        throw new Error(`Session delivery ${id} is no longer pending`);
      });
    }
    case "sessionDelivery.complete": {
      const { id } = command.input;
      return finalize(id, "completed", () => {
        completeDeliveryQueueEntryInDatabase(database, resolveSessionDeliveryQueueName(id), id);
      });
    }
    case "sessionDelivery.fail": {
      const { id, error, releaseAttemptOwnership } = command.input;
      update(id, (entry) => {
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
      return;
    }
    case "sessionDelivery.load":
      return readSessionDelivery(database, command.input.id);
    case "sessionDelivery.list": {
      const entries = [SESSION_DELIVERY_QUEUE_NAME, NATIVE_CHILD_DELIVERY_QUEUE_NAME].flatMap(
        (queueName) => loadDeliveryQueueEntriesInDatabase(database, queueName),
      );
      // SAFETY: All returned rows belong to the canonical session-delivery namespace.
      return entries.toSorted((a, b) => a.enqueuedAt - b.enqueuedAt) as QueuedSessionDelivery[];
    }
    case "sessionDelivery.moveToFailed": {
      const { id } = command.input;
      return finalize(id, "failed", () => {
        const entry = readSessionDelivery(database, id);
        if (!entry) {
          throw deliveryQueueEntryNotFoundError(resolveSessionDeliveryQueueName(id), id);
        }
        const result = terminalizePendingDeliveryQueueEntryInDatabase(
          database,
          prepareDeliveryQueueTerminalEntry({
            queueName: resolveSessionDeliveryQueueName(id),
            id,
            entry,
          }),
        );
        if (result.status !== "terminalized") {
          throw deliveryQueueEntryNotFoundError(resolveSessionDeliveryQueueName(id), id);
        }
      });
    }
  }
}
