import { randomUUID } from "node:crypto";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../state/worker-operation-registry.js";
import { loadDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite-bound.js";
import {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
  dispatchDeliveryQueueEntryPlatformSendInDatabase,
  promoteDeliveryQueueEntryPlatformSendInDatabase,
  transitionOwnedDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-claim.kernel.js";
import {
  completePendingDeliveryQueueEntryInDatabase,
  replacePendingDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryOnceAcrossNamespacesInDatabase,
} from "./delivery-queue-sqlite-namespace.kernel.js";
import {
  countFailedDeliveryQueueEntriesInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  pruneExpiredDeliveryQueueTombstonesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  reserveDeliveryQueueEntryAttemptInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import { retireUnsentDeliveryInDatabase } from "./outbound/delivery-queue-ack.kernel.js";
import { executeDeliveryQueueAck } from "./outbound/delivery-queue-ack.worker.js";
import { executeDeliveryQueueEnqueue } from "./outbound/delivery-queue-enqueue.worker.js";
import {
  createDeliveryQueueMediaRetentionInDatabase,
  loadDeliveryQueueMediaRetentionSnapshotInDatabase,
} from "./outbound/delivery-queue-media-staging.kernel.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  outboundDeliveryQueueName,
} from "./outbound/delivery-queue-namespaces.js";
import {
  findDeliveryIntentOwnersInDatabase,
  resolveOutboundDeliveryQueueNameInDatabase,
} from "./outbound/delivery-queue-ownership.kernel.js";
import { executePendingDeliveryFailure } from "./outbound/delivery-queue-pending-failure.worker.js";
import {
  decodeOutboundDeliverySnapshot,
  encodeOutboundDeliverySnapshot,
  projectOutboundDelivery,
} from "./outbound/delivery-queue-projection.js";
import {
  loadOutboundDeliveryInDatabase,
  restoreDeliveryAttemptBeforeDispatchInDatabase,
} from "./outbound/delivery-queue-storage.kernel.js";
import type {
  StableDeliveryPreparation,
  OutboundDeliverySnapshot,
} from "./outbound/delivery-queue-storage.types.js";
import {
  hasActiveDeliveryOwner,
  type QueuedDelivery,
  type DeliveryFailureSettlement,
} from "./outbound/delivery-queue-types.js";

type OutboundDeliveryMutation = {
  id: string;
  expectedPlatformSendAttemptId?: string | null;
} & (
  | { kind: "fail" | "fail-before-send" | "fail-after-send"; error: string }
  | { kind: "start" | "dispatch"; route?: { replyToId?: string | null } }
  | { kind: "unknown" }
);

function claimPreparation(
  database: OpenClawStateDatabase,
  id: string,
): { status: "claimed"; entry: StableDeliveryPreparation } | { status: "existing" } {
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

function writeOperation<Input, Output>(
  operationLabel: string,
  operation: (database: OpenClawStateDatabase, input: Input) => Output,
) {
  return (input: Input, { open, stateOptions }: WorkerOperationContext): Output =>
    runOpenClawStateWriteTransaction(
      (database) => operation(database, input),
      { database: open(), ...stateOptions() },
      { operationLabel },
    );
}

export const deliveryQueueOperations = {
  "deliveryQueue.claimPreparation": writeOperation(
    "deliveryQueue.claimPreparation",
    (database, input: { id: string }) => claimPreparation(database, input.id),
  ),
  "deliveryQueue.replacePreparation": writeOperation(
    "deliveryQueue.replacePreparation",
    (
      database,
      input: {
        expectedEntry: StableDeliveryPreparation;
        replacementEntry: StableDeliveryPreparation;
      },
    ) =>
      replacePendingDeliveryQueueEntryInDatabase(database, {
        queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        ...input,
      }),
  ),
  "deliveryQueue.completePreparation": writeOperation(
    "deliveryQueue.completePreparation",
    (database, input: { expectedEntry: StableDeliveryPreparation }) =>
      completePendingDeliveryQueueEntryInDatabase(database, {
        queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        ...input,
      }),
  ),
  "deliveryQueue.failPreparation": writeOperation(
    "deliveryQueue.failPreparation",
    (database, input: { entry: StableDeliveryPreparation }) => {
      terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepareDeliveryQueueTerminalEntry({
          queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
          id: input.entry.id,
          entry: input.entry,
        }),
      );
    },
  ),
  "deliveryQueue.mutateOutbound": writeOperation("deliveryQueue.mutateOutbound", mutateOutbound),
  "deliveryQueue.reserveOutbound": writeOperation(
    "deliveryQueue.reserveOutbound",
    (
      database,
      input: { id: string; maxAttempts: number; expectedPlatformSendAttemptId?: string },
    ) =>
      reserveDeliveryQueueEntryAttemptInDatabase(database, {
        ...input,
        queueName: resolveOutboundDeliveryQueueNameInDatabase(database, input.id),
      }),
  ),
  "deliveryQueue.restoreOutbound": writeOperation(
    "deliveryQueue.restoreOutbound",
    (
      database,
      input: {
        entry: OutboundDeliverySnapshot;
        reservedAttemptCount: number;
        claimedAttemptId?: string;
      },
    ) =>
      restoreDeliveryAttemptBeforeDispatchInDatabase(
        database,
        decodeOutboundDeliverySnapshot(input.entry),
        input.reservedAttemptCount,
        input.claimedAttemptId,
      ),
  ),
  "deliveryQueue.stageFailure": writeOperation(
    "deliveryQueue.stageFailure",
    (
      database,
      input: {
        entry: OutboundDeliverySnapshot;
        settlementEntry: OutboundDeliverySnapshot;
        claimedAttemptId?: string;
      },
    ) => {
      const entry = decodeOutboundDeliverySnapshot(input.entry);
      const settlementEntry = decodeOutboundDeliverySnapshot(input.settlementEntry);
      if (
        settlementEntry.id !== entry.id ||
        input.settlementEntry.queueName !== input.entry.queueName ||
        !settlementEntry.settlement
      ) {
        throw new Error(`Invalid outbound delivery settlement snapshot: ${entry.id}`);
      }
      const staged = stageFailure(database, {
        entry,
        settlement: settlementEntry.settlement,
        claimedAttemptId: input.claimedAttemptId,
      });
      return staged && encodeOutboundDeliverySnapshot(staged);
    },
  ),
  "deliveryQueue.finalizeFailure": writeOperation(
    "deliveryQueue.finalizeFailure",
    (database, input: { entry: OutboundDeliverySnapshot }) => {
      const entry = decodeOutboundDeliverySnapshot(input.entry);
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
    },
  ),
  "deliveryQueue.retireUnsent": writeOperation(
    "deliveryQueue.retireUnsent",
    (
      database,
      input: { id: string; producerClaimId: string; stateDir?: string; terminalOutcome?: "failed" },
    ) => retireUnsentDeliveryInDatabase(database, input, input.terminalOutcome),
  ),
  "deliveryQueue.claimPlatformSend": writeOperation(
    "deliveryQueue.claimPlatformSend",
    (
      database,
      input: Omit<
        Parameters<typeof claimDeliveryQueueEntryPlatformSendInDatabase>[1],
        "queueName"
      > & { claimId: string },
    ) =>
      claimDeliveryQueueEntryPlatformSendInDatabase(
        database,
        {
          ...input,
          queueName: resolveOutboundDeliveryQueueNameInDatabase(database, input.id),
        },
        input.claimId,
      ),
  ),
  "deliveryQueue.renewPlatformSendLease": writeOperation(
    "deliveryQueue.renewPlatformSendLease",
    (
      database,
      input: Omit<
        Parameters<typeof renewDeliveryQueueEntryPlatformSendLeaseInDatabase>[1],
        "queueName"
      >,
    ) =>
      renewDeliveryQueueEntryPlatformSendLeaseInDatabase(database, {
        ...input,
        queueName: resolveOutboundDeliveryQueueNameInDatabase(database, input.id),
      }),
  ),
  "deliveryQueue.ack": (
    input: Parameters<typeof executeDeliveryQueueAck>[0],
    { open, stateOptions },
  ) => executeDeliveryQueueAck(input, { database: open(), ...stateOptions() }),
  "deliveryQueue.enqueue": (
    input: Parameters<typeof executeDeliveryQueueEnqueue>[0],
    { open, stateOptions },
  ) => executeDeliveryQueueEnqueue(input, { database: open(), ...stateOptions() }),
  "deliveryQueue.failPending": (
    input: Parameters<typeof executePendingDeliveryFailure>[0],
    { open, stateOptions },
  ) => executePendingDeliveryFailure(input, { database: open(), ...stateOptions() }),
  "deliveryQueue.findIntentOwners": (
    input: Parameters<typeof findDeliveryIntentOwnersInDatabase>[1],
    { open },
  ) => findDeliveryIntentOwnersInDatabase(open(), input),
  "deliveryQueue.countFailed": (_input: undefined, { open }) =>
    countFailedDeliveryQueueEntriesInDatabase(open()),
  "deliveryQueue.pruneTombstones": (_input: undefined, { open }) =>
    pruneExpiredDeliveryQueueTombstonesInDatabase(open()),
  "deliveryQueue.createMediaRetention": writeOperation(
    "deliveryQueue.createMediaRetention",
    (
      database,
      input: {
        artifacts: string[];
        entryKind: Parameters<typeof createDeliveryQueueMediaRetentionInDatabase>[2];
        prepared: { id: string; enqueuedAt: number };
      },
    ) =>
      createDeliveryQueueMediaRetentionInDatabase(
        database,
        input.artifacts,
        input.entryKind,
        input.prepared,
      ),
  ),
  "deliveryQueue.cancelMediaRetention": writeOperation(
    "deliveryQueue.cancelMediaRetention",
    (database, input: { id: string }) =>
      deleteDeliveryQueueEntryInDatabase(
        database,
        DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
        input.id,
      ),
  ),
  "deliveryQueue.mediaRetentionSnapshot": (
    input: Parameters<typeof loadDeliveryQueueMediaRetentionSnapshotInDatabase>[1],
    { open },
  ) => loadDeliveryQueueMediaRetentionSnapshotInDatabase(open(), input),
} satisfies WorkerOperationHandlers;
