import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  resolveUpdateConfirmationProbation,
  sealUpdateConfirmationReplayAdmissions,
} from "../infra/update-confirmation-runtime.js";
import { markUpdateTransactionDeliveryAck } from "../infra/update-transaction-marker.js";

const UPDATE_TRANSACTION_PENDING_RETRY_DELAY_MS = process.env.VITEST ? 1 : 250;
const confirmationPersistenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleConfirmedUpdateProbationRelease(handoffId: string): void {
  if (confirmationPersistenceTimers.has(handoffId)) {
    return;
  }
  const timer = setTimeout(async () => {
    confirmationPersistenceTimers.delete(handoffId);
    try {
      await resolveUpdateConfirmationProbation(handoffId, "confirmed");
    } catch {
      scheduleConfirmedUpdateProbationRelease(handoffId);
    }
  }, UPDATE_TRANSACTION_PENDING_RETRY_DELAY_MS);
  timer.unref?.();
  confirmationPersistenceTimers.set(handoffId, timer);
}

function scheduleDeliveryConfirmationPersistence(
  handoffId: string,
  confirmationTier: "delivery" | "human",
): void {
  if (confirmationPersistenceTimers.has(handoffId)) {
    return;
  }
  const timer = setTimeout(async () => {
    confirmationPersistenceTimers.delete(handoffId);
    try {
      if (
        confirmationTier === "delivery" &&
        !(await sealUpdateConfirmationReplayAdmissions(handoffId))
      ) {
        scheduleDeliveryConfirmationPersistence(handoffId, confirmationTier);
        return;
      }
      const updated = await markUpdateTransactionDeliveryAck({ handoffId });
      if (
        updated?.payload.stats?.confirmationTier === "delivery" &&
        updated.payload.stats.confirmationStatus === "delivery-acked"
      ) {
        await resolveUpdateConfirmationProbation(handoffId, "confirmed");
      }
    } catch {
      scheduleDeliveryConfirmationPersistence(handoffId, confirmationTier);
    }
  }, UPDATE_TRANSACTION_PENDING_RETRY_DELAY_MS);
  timer.unref?.();
  confirmationPersistenceTimers.set(handoffId, timer);
}

export function scheduleUpdateTransactionRetry(params: {
  attempt: number;
  retry: (attempt: number) => Promise<void>;
  onError: (error: unknown) => void;
}): void {
  const timer = setTimeout(() => {
    const nextAttempt = params.attempt + 1;
    void params.retry(nextAttempt).catch((error: unknown) => {
      params.onError(error);
      scheduleUpdateTransactionRetry({ ...params, attempt: nextAttempt });
    });
  }, UPDATE_TRANSACTION_PENDING_RETRY_DELAY_MS);
  timer.unref?.();
}

export async function handleUpdateTransactionNoticeDelivery(params: {
  payload: RestartSentinelPayload;
  delivery: "acknowledged" | "pending" | "rejected";
  scheduleRetry: () => void;
}): Promise<void> {
  if (params.delivery === "pending") {
    params.scheduleRetry();
    return;
  }
  if (params.delivery !== "acknowledged") {
    return;
  }
  const handoffId = params.payload.stats!.handoffId!;
  const confirmationTier = params.payload.stats!.confirmationTier!;
  if (
    confirmationTier === "delivery" &&
    !(await sealUpdateConfirmationReplayAdmissions(handoffId))
  ) {
    scheduleDeliveryConfirmationPersistence(handoffId, confirmationTier);
    return;
  }
  let updated: Awaited<ReturnType<typeof markUpdateTransactionDeliveryAck>>;
  try {
    updated = await markUpdateTransactionDeliveryAck({ handoffId });
    if (
      updated?.payload.stats?.confirmationTier === "delivery" &&
      updated.payload.stats.confirmationStatus === "delivery-acked"
    ) {
      await resolveUpdateConfirmationProbation(handoffId, "confirmed");
    }
  } catch {
    // Persistence and the local probation release form one retryable unit. The
    // durable acknowledgement is idempotent, so replay can safely finish work
    // after a transient queue-release failure.
    scheduleDeliveryConfirmationPersistence(handoffId, confirmationTier);
  }
}
