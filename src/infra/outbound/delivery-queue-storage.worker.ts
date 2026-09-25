import { randomUUID } from "node:crypto";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { loadDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-bound.js";
import {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  dispatchDeliveryQueueEntryPlatformSendInDatabase,
  promoteDeliveryQueueEntryPlatformSendInDatabase,
  transitionOwnedDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite-claim.kernel.js";
import {
  completePendingDeliveryQueueEntryInDatabase,
  replacePendingDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase,
} from "../delivery-queue-sqlite-namespace.kernel.js";
import {
  prepareDeliveryQueueTerminalEntry,
  reserveDeliveryQueueEntryAttemptInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import type { SqliteWorkerCommand } from "../sqlite-worker-contract.js";
import { retireUnsentDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import {
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  outboundDeliveryQueueName,
} from "./delivery-queue-namespaces.js";
import { resolveOutboundDeliveryQueueNameInDatabase } from "./delivery-queue-ownership.kernel.js";
import {
  decodeOutboundDeliverySnapshot,
  encodeOutboundDeliverySnapshot,
  projectOutboundDelivery,
} from "./delivery-queue-projection.js";
import {
  loadOutboundDeliveryInDatabase,
  restoreDeliveryAttemptBeforeDispatchInDatabase,
} from "./delivery-queue-storage.kernel.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";
import type {
  OutboundDeliveryMutation,
  OutboundDeliveryStorageOperations,
} from "./delivery-queue-storage.worker-contract.js";
import {
  hasActiveDeliveryOwner,
  type QueuedDelivery,
  type DeliveryFailureSettlement,
} from "./delivery-queue-types.js";

function claimPreparation(
  database: OpenClawStateDatabase,
  id: string,
): OutboundDeliveryStorageOperations["deliveryQueue.claimPreparation"]["output"] {
  const now = Date.now();
  const proposed: StableDeliveryPreparation = {
    id,
    enqueuedAt: now,
    retryCount: 0,
    attemptCount: 0,
    retainOnFailure: true,
    preparationState: "claimed",
    preparationOwnerId: randomUUID(),
    preparationLeaseExpiresAt: now + 5 * 60_000,
  };
  const queueName = OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME;
  if (
    upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase(database, {
      queueName,
      entry: proposed,
      conflictQueueNames: [
        ...OUTBOUND_EXECUTABLE_QUEUE_NAMES,
        OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
        OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
        LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      ],
    })
  ) {
    return { status: "claimed", entry: proposed };
  }
  const stored = loadDeliveryQueueEntryInDatabase(database, queueName, id, "pending");
  // SAFETY: Only this preparation owner writes the payload-free namespace.
  const current = stored as StableDeliveryPreparation | null;
  if (!current || (current.preparationLeaseExpiresAt ?? 0) > Date.now()) {
    return { status: "existing" };
  }
  if (current.preparationState !== "claimed") {
    terminalizePendingDeliveryQueueEntryInDatabase(
      database,
      prepareDeliveryQueueTerminalEntry({ queueName, id, entry: current }),
    );
    return { status: "existing" };
  }
  return replacePendingDeliveryQueueEntryInDatabase(database, {
    queueName,
    expectedEntry: current,
    replacementEntry: proposed,
  })
    ? { status: "claimed", entry: proposed }
    : { status: "existing" };
}

function mutateOutbound(database: OpenClawStateDatabase, input: OutboundDeliveryMutation): void {
  const queueName = resolveOutboundDeliveryQueueNameInDatabase(database, input.id);
  const claimId = input.expectedPlatformSendAttemptId;
  if ((input.kind === "start" || input.kind === "dispatch") && typeof claimId === "string") {
    const mutate =
      input.kind === "start"
        ? promoteDeliveryQueueEntryPlatformSendInDatabase
        : dispatchDeliveryQueueEntryPlatformSendInDatabase;
    if (!mutate(database, { queueName, id: input.id, claimId, route: input.route })) {
      throw new Error(`Delivery platform claim was lost: ${input.id}`);
    }
    return;
  }
  const update = (entry: QueuedDelivery): QueuedDelivery => {
    const now = Date.now();
    switch (input.kind) {
      case "fail":
      case "fail-before-send":
      case "fail-after-send":
        return {
          ...entry,
          retryCount: entry.retryCount + 1,
          lastAttemptAt: now,
          lastError: input.error,
          availableAt: undefined,
          producerClaimId: undefined,
          ...(input.kind === "fail-before-send"
            ? {
                platformSendAttemptId: undefined,
                platformSendStartedAt: undefined,
                recoveryState: undefined,
              }
            : input.kind === "fail-after-send"
              ? {
                  platformSendStartedAt: entry.platformSendStartedAt ?? now,
                  recoveryState: "unknown_after_send",
                }
              : {
                  recoveryState:
                    entry.recoveryState === "producer_claimed" ? undefined : entry.recoveryState,
                }),
        };
      case "start":
      case "dispatch":
        return {
          ...entry,
          availableAt: undefined,
          producerClaimId: undefined,
          platformSendStartedAt:
            input.kind === "dispatch" ? now : (entry.platformSendStartedAt ?? now),
          ...(input.route && "replyToId" in input.route
            ? { effectiveReplyToId: input.route.replyToId ?? null }
            : {}),
          recoveryState:
            input.kind === "dispatch" && entry.recoveryState === "unknown_after_send"
              ? entry.recoveryState
              : "send_attempt_started",
        };
      case "unknown":
        return {
          ...entry,
          availableAt:
            claimId &&
            entry.requiresProducerClaim === true &&
            entry.platformSendAttemptId === claimId
              ? entry.availableAt
              : undefined,
          producerClaimId: undefined,
          platformSendStartedAt: entry.platformSendStartedAt ?? now,
          recoveryState: "unknown_after_send",
        };
    }
    return input satisfies never;
  };
  if (claimId !== undefined) {
    const changed = transitionOwnedDeliveryQueueEntryInDatabase(
      database,
      { queueName, id: input.id, platformSendAttemptId: claimId },
      (entry) => {
        upsertDeliveryQueueEntryInDatabase(
          { queueName, entry: update(projectOutboundDelivery(queueName, entry)) },
          database,
        );
      },
    );
    if (!changed) {
      throw new Error(`Delivery platform claim was lost: ${input.id}`);
    }
  } else {
    updateDeliveryQueueEntryInDatabase(database, queueName, input.id, (entry) => {
      return update(projectOutboundDelivery(queueName, entry));
    });
  }
}

function stageFailure(
  database: OpenClawStateDatabase,
  input: {
    entry: QueuedDelivery;
    settlement: DeliveryFailureSettlement;
    claimedAttemptId?: string;
  },
): QueuedDelivery | undefined {
  const { entry, settlement, claimedAttemptId } = input;
  const queueName = outboundDeliveryQueueName(entry);
  if (entry.settlement) {
    const current = loadOutboundDeliveryInDatabase(database, entry.id, "unfinished");
    return current && JSON.stringify(current) === JSON.stringify(entry) ? current : undefined;
  }
  const reclaim = entry.recoveryState === "producer_claimed" && claimedAttemptId === undefined;
  const attemptId = reclaim
    ? claimDeliveryQueueEntryPlatformSendInDatabase(database, { queueName, id: entry.id })
    : (claimedAttemptId ?? entry.platformSendAttemptId ?? null);
  if (reclaim && !attemptId) {
    return undefined;
  }
  let staged: QueuedDelivery | undefined;
  transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    { queueName, id: entry.id, platformSendAttemptId: attemptId ?? null },
    (current) => {
      if (
        !reclaim &&
        claimedAttemptId === undefined &&
        hasActiveDeliveryOwner(current, Date.now())
      ) {
        return;
      }
      staged = {
        ...projectOutboundDelivery(queueName, current),
        recoveryState: "settlement_pending",
        settlement,
      };
      upsertDeliveryQueueEntryInDatabase(
        { queueName, entry: staged, status: "failed", updatePendingOnly: true },
        database,
      );
    },
  );
  return staged;
}

export function executeOutboundDeliveryStorageCommand(
  command: SqliteWorkerCommand<OutboundDeliveryStorageOperations>,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): OutboundDeliveryStorageOperations[keyof OutboundDeliveryStorageOperations]["output"] {
  return runOpenClawStateWriteTransaction(
    (database) => {
      switch (command.type) {
        case "deliveryQueue.claimPreparation":
          return claimPreparation(database, command.input.id);
        case "deliveryQueue.replacePreparation":
          return replacePendingDeliveryQueueEntryInDatabase(database, {
            queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
            ...command.input,
          });
        case "deliveryQueue.completePreparation":
          return completePendingDeliveryQueueEntryInDatabase(database, {
            queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
            ...command.input,
          });
        case "deliveryQueue.failPreparation":
          terminalizePendingDeliveryQueueEntryInDatabase(
            database,
            prepareDeliveryQueueTerminalEntry({
              queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
              id: command.input.entry.id,
              entry: command.input.entry,
            }),
          );
          return;
        case "deliveryQueue.mutateOutbound":
          return mutateOutbound(database, command.input);
        case "deliveryQueue.reserveOutbound":
          return reserveDeliveryQueueEntryAttemptInDatabase(database, {
            ...command.input,
            queueName: resolveOutboundDeliveryQueueNameInDatabase(database, command.input.id),
          });
        case "deliveryQueue.restoreOutbound":
          return restoreDeliveryAttemptBeforeDispatchInDatabase(
            database,
            decodeOutboundDeliverySnapshot(command.input.entry),
            command.input.reservedAttemptCount,
            command.input.claimedAttemptId,
          );
        case "deliveryQueue.stageFailure": {
          const entry = decodeOutboundDeliverySnapshot(command.input.entry);
          const settlementEntry = decodeOutboundDeliverySnapshot(command.input.settlementEntry);
          if (
            settlementEntry.id !== entry.id ||
            command.input.settlementEntry.queueName !== command.input.entry.queueName ||
            !settlementEntry.settlement
          ) {
            throw new Error(`Invalid outbound delivery settlement snapshot: ${entry.id}`);
          }
          const staged = stageFailure(database, {
            entry,
            settlement: settlementEntry.settlement,
            claimedAttemptId: command.input.claimedAttemptId,
          });
          return staged && encodeOutboundDeliverySnapshot(staged);
        }
        case "deliveryQueue.finalizeFailure": {
          const entry = decodeOutboundDeliverySnapshot(command.input.entry);
          return (
            terminalizePendingDeliveryQueueEntryInDatabase(
              database,
              prepareDeliveryQueueTerminalEntry({
                queueName: outboundDeliveryQueueName(entry),
                id: entry.id,
                entry,
                expectedStatus: "failed",
              }),
            ).status === "terminalized"
          );
        }
        case "deliveryQueue.retireUnsent":
          return retireUnsentDeliveryInDatabase(
            database,
            command.input,
            command.input.terminalOutcome,
          );
      }
    },
    options,
    { operationLabel: command.type },
  );
}
