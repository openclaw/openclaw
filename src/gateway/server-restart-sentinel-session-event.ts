import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { markSessionDeliveryAttemptStarted } from "../infra/session-delivery-queue-storage.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue.records.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

export async function deliverRestartSentinelEvent(
  entry: QueuedSessionDelivery,
  sessionKey: string,
  agentId: string,
  queueContext: OpenClawStateWorkerContext,
) {
  if (entry.deliveryStartedAt !== undefined) {
    throw new SessionDeliveryDeadLetteredError(
      "queued session event dead-lettered after an interrupted unproven attempt",
    );
  }
  const assertCurrent = () => queueContext.admission.assertCurrent();
  assertCurrent();
  const expectedTarget = await captureSessionEventTargetForHost(agentId, sessionKey, {
    env: queueContext.environment,
    assertCurrent,
  });
  assertCurrent();
  const message = entry.kind === "systemEvent" ? entry.text : entry.message;
  const deliveryContext =
    entry.kind === "agentTurn" && entry.route
      ? {
          channel: entry.route.channel,
          to: entry.route.to,
          ...(entry.route.accountId ? { accountId: entry.route.accountId } : {}),
          ...(entry.route.threadId ? { threadId: entry.route.threadId } : {}),
        }
      : entry.deliveryContext;
  let adopted = false;
  let adoptionError: Error | undefined;
  const receipt = enqueueSessionEventForHost(message, {
    agentId,
    sessionKey,
    source: "restart",
    contextKey: `task:restart-sentinel:${entry.id}`,
    ...(deliveryContext ? { deliveryContext } : {}),
    expectedTarget,
    assertCurrent,
    onAdopted: async () => {
      try {
        await markSessionDeliveryAttemptStarted(entry, queueContext);
      } catch (error) {
        adoptionError =
          error instanceof Error
            ? error
            : new Error("Restart session event adoption failed", { cause: error });
        throw adoptionError;
      }
      adopted = true;
      assertCurrent();
    },
  });
  const outcome = await receipt.settled;
  assertCurrent();
  if (outcome.status !== "completed") {
    if (adoptionError) {
      throw adoptionError;
    }
    const errorMessage = outcome.error ?? `restart session event ${outcome.status}`;
    if (adopted || outcome.executionStarted) {
      throw new SessionDeliveryDeadLetteredError(errorMessage);
    }
    throw new SessionDeliverySafeRetryError(errorMessage);
  }
}
