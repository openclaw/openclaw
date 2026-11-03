// Continuation (karmaterminal): the refused outcome of a continuation return. A return whose
// recipient authority advanced (delete and recreate, owner change, visibility narrowing, member
// removal) is refused at whichever boundary sees it first: enqueue, restart replay, wake
// handoff or prompt drain. A refused return is never delivered, woken or acknowledged as
// adopted; its durable row settles as a bounded `failed` receipt for its deterministic id, which
// fences a duplicate announce of the same return while it lasts, and each refusal is reported
// with a stable reason.
import {
  loadPendingSessionDelivery,
  moveSessionDeliveryToFailed,
} from "../../infra/session-delivery-queue-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

type ContinuationReturnRefusalReason = "recipient-authority-changed";
export type ContinuationReturnRefusalStage = "enqueue" | "replay" | "wake" | "prompt-drain";

const log = createSubsystemLogger("continuation/return-refused");

export function reportRefusedContinuationReturn(params: {
  stage: ContinuationReturnRefusalStage;
  reason: ContinuationReturnRefusalReason;
  sessionKey: string;
  deliveryId?: string;
}): void {
  const message = `[continuation:return-refused] stage=${params.stage} reason=${params.reason} session=${params.sessionKey}${params.deliveryId ? ` deliveryId=${params.deliveryId}` : ""}`;
  // The file log keeps the fields structured; the console line already spells them out.
  log.warn(message, { ...params, consoleMessage: message });
}

/**
 * Retires a refused return's durable row unadopted, as its bounded `failed` receipt. A row already
 * gone was settled by another boundary; a refusal has no effect to repeat, so there is nothing
 * left to do.
 */
export async function refuseContinuationReturnDelivery(
  deliveryId: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  const entry = await loadPendingSessionDelivery(deliveryId, context);
  if (!entry) {
    return;
  }
  // One write from the pending row to its receipt, with no settlement marked first: if it is lost,
  // the row stays pending and replay decides it again (authority epochs never come back). Accepted
  // edge: a boundary that removes the row between the load and this write makes the write fail
  // visibly; the next boundary to see the return finds no row.
  await moveSessionDeliveryToFailed(deliveryId, context, { keepFailedReceipt: true });
}
