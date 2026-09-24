// Persists queue state around the irreversible platform-send boundary.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
  resolveDeliveryNotSentRetryability,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { OutboundHandoffRejectedError } from "./deliver-handoff.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryQueuePolicy,
  type OutboundPayloadDeliveryOutcome,
  type PlatformMessageNotDispatchedError,
  type PlatformSendRoute,
} from "./deliver-types.js";
import { rejectDurableDelivery, type ConversationDeliveryTarget } from "./delivery-completion.js";
import { retireUnsentDelivery } from "./delivery-queue-ack.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  ackDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  finalizeDeliveryFailureSettlement,
  loadPendingDelivery,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
  stageDeliveryFailureSettlement,
} from "./delivery-queue-storage.js";
import type { DeliveryFailureSettlement, QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

const log = createSubsystemLogger("outbound/deliver");

export type QueuedPostSendState = "marked" | "acked" | "failed";

export type QueuedPreSendState = "marked" | "acked";

type QueuedDeliveryFailureRecorder = (
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
) => Promise<void>;

/** Keeps live and recovered queue transitions on the same producer claim. */
export function createQueuedDeliveryOwner(
  params: {
    queueId: string;
    stateDir?: string;
    expectedPlatformSendAttemptId?: string | null;
    signal?: AbortSignal;
  },
  context?: DeliveryQueueStateContext,
) {
  let custody: "held" | "released" = "held";
  const owner = {
    queueId: params.queueId,
    stateDir: context?.stateDir ?? params.stateDir,
    claimId: params.expectedPlatformSendAttemptId,
    signal: params.signal,
    get custody() {
      return custody;
    },
    project(
      error: unknown,
      evidence?: Omit<ConstructorParameters<typeof OutboundDeliveryError>[1], "cause">,
    ): OutboundDeliveryError {
      const failure =
        error instanceof OutboundDeliveryError
          ? error
          : new OutboundDeliveryError(formatErrorMessage(error), {
              cause: error,
              ...evidence,
            });
      failure.queueCustody = custody;
      return failure;
    },
    async retireUnsent(terminalOutcome?: "failed"): ReturnType<typeof retireUnsentDelivery> {
      owner.signal?.throwIfAborted();
      if (!owner.claimId) {
        return undefined;
      }
      const release = await retireUnsentDelivery(
        {
          id: owner.queueId,
          producerClaimId: owner.claimId,
          stateDir: owner.stateDir,
        },
        context,
        terminalOutcome,
      );
      // Cleanup is returned only after the exact unsent claim has been retired.
      if (release) {
        custody = "released";
      }
      return release;
    },
    async ack(options?: Parameters<typeof ackDelivery>[2]): Promise<void> {
      owner.signal?.throwIfAborted();
      await ackDelivery(
        owner.queueId,
        owner.stateDir,
        {
          ...options,
          ...(owner.claimId !== undefined ? { expectedPlatformSendAttemptId: owner.claimId } : {}),
        },
        context,
      );
      custody = "released";
    },
    // Staged failure has left send custody; exact row equality now fences compaction.
    async finalizeFailure(entry: QueuedDelivery): Promise<boolean> {
      if (
        entry.id !== owner.queueId ||
        !(await finalizeDeliveryFailureSettlement(entry, owner.stateDir, context))
      ) {
        return false;
      }
      custody = "released";
      return true;
    },
    fail(record: QueuedDeliveryFailureRecorder, error: string): Promise<void> {
      owner.signal?.throwIfAborted();
      // Internal transitions retain captured state; caller-supplied recorders keep their public arguments.
      const recordInState =
        record === failDelivery
          ? failDelivery
          : record === failDeliveryAfterPlatformSend
            ? failDeliveryAfterPlatformSend
            : record === failDeliveryBeforePlatformSend
              ? failDeliveryBeforePlatformSend
              : undefined;
      return recordInState
        ? recordInState(owner.queueId, error, owner.stateDir, owner.claimId, context)
        : record(owner.queueId, error, owner.stateDir, owner.claimId);
    },
    async retire(): Promise<void> {
      owner.signal?.throwIfAborted();
      const spooled = await moveToFailed(
        owner.queueId,
        owner.stateDir,
        owner.claimId ?? null,
        context,
      );
      custody = "released";
      await releaseSpoolArtifacts(spooled, owner.stateDir);
    },
  };
  return owner;
}

export type QueuedDeliveryOwner = ReturnType<typeof createQueuedDeliveryOwner>;

export function findTerminalBatchRejection(errors: readonly unknown[]) {
  if (errors.length === 0 || !errors.every(isProvenDeliveryNotSentError)) {
    return undefined;
  }
  // A shared handoff rejection ends every unsent payload. Payload-specific
  // rejections must leave another payload's valid retry with recovery.
  return (
    errors.find((error) => error instanceof OutboundHandoffRejectedError) ??
    (errors.every((error) => resolveDeliveryNotSentRetryability(error) === false)
      ? findPlatformMessageRejectedError(errors[0])
      : undefined)
  );
}

export function isProvenBatchNotSent(
  error: unknown,
  outcomes: readonly OutboundPayloadDeliveryOutcome[],
): boolean {
  return (
    isProvenDeliveryNotSentError(error) &&
    outcomes.every((outcome) =>
      outcome.status === "failed"
        ? !outcome.sentBeforeError && isProvenDeliveryNotSentError(outcome.error)
        : outcome.status === "suppressed" && outcome.reason !== "adapter_returned_no_identity",
    )
  );
}

export async function rejectQueuedDelivery(
  owner: QueuedDeliveryOwner,
  rejection: PlatformMessageNotDispatchedError,
  params: {
    deliveryQueueStateContext?: DeliveryQueueStateContext;
    conversationDeliveryTarget?: ConversationDeliveryTarget;
  },
  terminals: DeliveryFailureSettlement["terminals"],
): Promise<boolean> {
  try {
    owner.signal?.throwIfAborted();
    const pending = await loadPendingDelivery(
      owner.queueId,
      owner.stateDir,
      params.deliveryQueueStateContext,
    );
    if (!pending || !owner.claimId) {
      return false;
    }
    let entry: QueuedDelivery | undefined;
    try {
      entry = await stageDeliveryFailureSettlement(
        pending,
        {
          outcome: "failed",
          error: rejection.message,
          rejectionError: rejection.message,
          terminals,
        },
        owner.stateDir,
        owner.claimId,
        params.deliveryQueueStateContext,
      );
    } catch (error) {
      // A staging failure may leave only the unsent claim. Its owner can retain
      // a failed receipt without bypassing send evidence or completion recovery.
      const release = await owner.retireUnsent("failed");
      if (!release) {
        throw error;
      }
      await release();
      return true;
    }
    if (!entry) {
      return false;
    }
    // The exact claim is now durably unsendable. Recovery resumes only this
    // idempotent completion projection if projection or terminal cleanup fails.
    if (entry.deliveryCompletion) {
      await rejectDurableDelivery(
        entry.deliveryCompletion,
        rejection.message,
        owner.stateDir,
        params.deliveryQueueStateContext,
        params.conversationDeliveryTarget,
      );
    }
    const spoolPaths = collectEntrySpoolPaths(
      acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload),
      owner.stateDir,
    );
    if (!(await owner.finalizeFailure(entry))) {
      return false;
    }
    await releaseSpoolArtifacts(spoolPaths, owner.stateDir);
  } catch (error) {
    log.warn(
      `failed to finalize permanently rejected delivery ${owner.queueId}: ${formatErrorMessage(error)}`,
    );
  }
  return owner.custody === "released";
}

export async function persistQueuedPreSendState(
  params: {
    owner: QueuedDeliveryOwner;
    queuePolicy: OutboundDeliveryQueuePolicy;
    route: PlatformSendRoute;
    retainSpoolArtifacts?: boolean;
  },
  context?: DeliveryQueueStateContext,
): Promise<QueuedPreSendState> {
  const { owner } = params;
  owner.signal?.throwIfAborted();
  try {
    const route = { replyToId: params.route.replyToId ?? null };
    await markDeliveryPlatformSendAttemptStarted(
      owner.queueId,
      owner.stateDir,
      route,
      owner.claimId || undefined,
      context,
    );
    return "marked";
  } catch (markErr: unknown) {
    if (params.queuePolicy === "required") {
      throw markErr;
    }
    log.warn(
      `failed to mark queued delivery ${owner.queueId} as platform-send-attempt-started; removing replay intent before best-effort send: ${formatErrorMessage(markErr)}`,
    );
    // Remove only the exact owner before crossing the platform boundary. A lost
    // claim or failed ack aborts the send instead of erasing a replacement owner.
    await owner.ack(params.retainSpoolArtifacts ? { retainSpoolArtifacts: true } : undefined);
    return "acked";
  }
}

export async function persistQueuedPostSendState(
  params: {
    owner: QueuedDeliveryOwner;
    queuePolicy: OutboundDeliveryQueuePolicy;
    preserveBatch?: boolean;
    retainSpoolArtifacts?: boolean;
    onPostSendMarkerError?: (error: unknown) => void;
  },
  context?: DeliveryQueueStateContext,
): Promise<QueuedPostSendState> {
  const { owner } = params;
  owner.signal?.throwIfAborted();
  try {
    await markDeliveryPlatformOutcomeUnknown(owner.queueId, owner.stateDir, owner.claimId, context);
    return "marked";
  } catch (markErr: unknown) {
    if (params.preserveBatch) {
      // A bounded batch may still contain identityless later payloads. Its
      // intermediate state must never become a premature success receipt.
      await owner.fail(
        failDeliveryAfterPlatformSend,
        `post-send state persistence failed: ${formatErrorMessage(markErr)}`,
      );
      return "failed";
    }
    params.onPostSendMarkerError?.(markErr);
    log.warn(
      `failed to mark queued delivery ${owner.queueId} as platform-outcome-unknown; falling back to direct ack (${params.queuePolicy}): ${formatErrorMessage(markErr)}`,
    );
    try {
      // The platform already returned a result. If state marking is unavailable,
      // deleting the intent is safer than leaving it replayable.
      await owner.ack(params.retainSpoolArtifacts ? { retainSpoolArtifacts: true } : undefined);
      return "acked";
    } catch (ackErr: unknown) {
      const error = `post-send state persistence failed: marker=${formatErrorMessage(markErr)}; ack=${formatErrorMessage(ackErr)}`;
      // Keep the evidence in the same canonical row if both primary state
      // transitions fail; a generic failure update would make it replayable.
      await owner.fail(failDeliveryAfterPlatformSend, error);
      return "failed";
    }
  }
}
