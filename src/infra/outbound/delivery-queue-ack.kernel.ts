// Canonical outbound settlement returns cleanup facts only after custody commits.
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { transitionOwnedDeliveryQueueEntryInDatabase } from "../delivery-queue-sqlite-claim.kernel.js";
import {
  completeDeliveryQueueEntryInDatabase,
  completeLoadedDeliveryQueueEntryInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import { hasLiveDeliveryQueueClaim } from "../delivery-queue-sqlite.types.js";
import { collectEntrySpoolPaths } from "./delivery-queue-media-paths.js";
import { createDeliveryQueueMediaRetentionInDatabase } from "./delivery-queue-media-staging.kernel.js";
import { outboundDeliveryQueueName } from "./delivery-queue-namespaces.js";
import { resolveOutboundDeliveryQueueNameInDatabase } from "./delivery-queue-ownership.kernel.js";
import type {
  AckDeliveryOptions,
  FailPendingDeliveryResult,
} from "./delivery-queue-settlement.types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

/** Retires an unsent live claim while its adapter preparation still owns resources. */
export function retireUnsentDeliveryInDatabase(
  database: OpenClawStateDatabase,
  params: {
    id: string;
    producerClaimId: string;
    stateDir?: string;
  },
  terminalOutcome?: "failed",
): { spoolPaths: string[]; retention?: string } | undefined {
  const stateDir = params.stateDir;
  const queueName = resolveOutboundDeliveryQueueNameInDatabase(database, params.id);
  let retired: { spoolPaths: string[]; retention?: string } | undefined;
  transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName,
      id: params.id,
      platformSendAttemptId: params.producerClaimId,
    },
    (current) => {
      if (
        current.recoveryState !== "producer_claimed" ||
        current.platformSendAttemptId !== undefined ||
        current.platformSendStartedAt !== undefined ||
        !hasLiveDeliveryQueueClaim(current, params.producerClaimId, Date.now())
      ) {
        return;
      }
      // The claim and absence of send evidence are checked in the same transaction
      // that retires custody. A stale snapshot must not erase a dispatched attempt.
      // SAFETY: This namespace's pending rows contain the prepared outbound batch.
      const entry = current as QueuedDelivery;
      // Completion-bearing rows need resumable projection through failure staging.
      if (terminalOutcome === "failed" && entry.deliveryCompletion) {
        return;
      }
      const artifacts = collectEntrySpoolPaths(
        acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload),
        stateDir,
      );
      if (
        terminalOutcome === "failed" &&
        terminalizePendingDeliveryQueueEntryInDatabase(
          database,
          prepareDeliveryQueueTerminalEntry({
            queueName,
            id: entry.id,
            entry,
            expectedStatus: "pending",
          }),
        ).status !== "terminalized"
      ) {
        return;
      }
      const retention = artifacts.length
        ? createDeliveryQueueMediaRetentionInDatabase(
            database,
            artifacts,
            "outbound-media-recovery-lease",
          )
        : undefined;
      if (terminalOutcome !== "failed") {
        // Cancellation removes custody without recording a successful receipt,
        // including for stable intents with completion retention.
        deleteDeliveryQueueEntryInDatabase(database, queueName, entry.id);
      }
      retired = { spoolPaths: artifacts, retention };
    },
  );
  return retired;
}

export function ackDeliveryInDatabase(
  database: OpenClawStateDatabase,
  id: string,
  requestedStateDir?: string,
  options?: AckDeliveryOptions,
): string[] {
  const stateDir = requestedStateDir;
  const queueName = resolveOutboundDeliveryQueueNameInDatabase(database, id);
  // Read the media references before the row goes, then unlink only after the
  // delete commits. A crash in between leaves an orphan for the retention sweep;
  // unlinking first could strip media from a row that still has to replay.
  let spoolPaths: string[] = [];
  const settle = (current: QueuedDelivery | null): void => {
    spoolPaths = current
      ? collectEntrySpoolPaths(
          acceptedPreparedOutboundEntries(current.preparedBatch).map(
            (prepared) => prepared.payload,
          ),
          stateDir,
        )
      : [];
    if (current?.completionRetention && options?.suppressCompletionReceipt !== true) {
      if (options && "expectedPlatformSendAttemptId" in options) {
        completeLoadedDeliveryQueueEntryInDatabase(database, queueName, id, current);
      } else {
        completeDeliveryQueueEntryInDatabase(database, queueName, id);
      }
    } else {
      deleteDeliveryQueueEntryInDatabase(database, queueName, id);
    }
  };
  // A claimless caller has no owner to assert, so an unclaimed row settles and an
  // already-missing row is a no-op; either way it must never touch a live claim.
  const platformSendAttemptId =
    options && "expectedPlatformSendAttemptId" in options
      ? (options.expectedPlatformSendAttemptId ?? null)
      : null;
  const settled = transitionOwnedDeliveryQueueEntryInDatabase(
    database,
    {
      queueName,
      id,
      platformSendAttemptId,
      allowMissingEntry: !(options && "expectedPlatformSendAttemptId" in options),
    },
    (entry) => {
      // SAFETY: Pending rows in this namespace retain the prepared outbound payload.
      settle(entry as QueuedDelivery);
    },
  );
  if (!settled) {
    throw new Error(`Delivery platform claim was lost: ${id}`);
  }
  return spoolPaths;
}

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export function failPendingDeliveryInDatabase(
  database: OpenClawStateDatabase,
  params: {
    id: string;
    entry: QueuedDelivery;
    retainSpoolArtifacts?: boolean;
    expectedPlatformSendAttemptId?: string | null;
  },
  preparedTerminal?: ReturnType<typeof prepareDeliveryQueueTerminalEntry>,
): FailPendingDeliveryResult {
  const queueName = outboundDeliveryQueueName(params.entry);
  const terminal = { queueName, id: params.id, entry: params.entry };
  // An unmatched claim must remain a no-op; standalone calls validate before opening state.
  const prepared =
    params.expectedPlatformSendAttemptId === undefined
      ? (preparedTerminal ?? prepareDeliveryQueueTerminalEntry(terminal))
      : undefined;
  let terminalized = false;
  const terminalize = (): undefined => {
    terminalized =
      terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepared ?? prepareDeliveryQueueTerminalEntry(terminal),
      ).status === "terminalized";
  };
  if (params.expectedPlatformSendAttemptId !== undefined) {
    transitionOwnedDeliveryQueueEntryInDatabase(
      database,
      {
        queueName,
        id: params.id,
        platformSendAttemptId: params.expectedPlatformSendAttemptId,
      },
      terminalize,
    );
  } else {
    terminalize();
  }
  if (terminalized) {
    return { status: "failed" };
  }
  return { status: "not_pending" };
}
