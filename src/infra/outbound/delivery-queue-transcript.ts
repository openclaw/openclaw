// Records recovered deliveries in their destination conversation when content is provable.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitConfirmedVisibleMessage } from "../../sessions/confirmed-visible-message.js";
import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { formatErrorMessage } from "../errors.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

type RecoveryTranscriptOptions = {
  cfg: OpenClawConfig;
  entry: QueuedDelivery;
  log: { warn(message: string): void };
};

/**
 * Records a delivery confirmed during recovery, only when one accepted text payload
 * proves exactly what was shown. Anything else warns instead of guessing.
 */
export async function commitRecoveredVisibleMessages(
  opts: RecoveryTranscriptOptions,
  stateContext: DeliveryQueueStateContext,
): Promise<void> {
  const { entry } = opts;
  const accepted = acceptedPreparedOutboundEntries(entry.preparedBatch);
  const prepared = accepted[0];
  const rendered = entry.renderedBatchPlan?.items[0];
  if (
    entry.legacyPreparedContentUnavailable ||
    entry.preparedBatch.channelNormalized !== true ||
    accepted.length !== 1 ||
    !prepared ||
    !prepared.payload.text?.trim() ||
    entry.renderedBatchPlan?.items.length !== 1 ||
    !rendered ||
    rendered.index !== 0 ||
    rendered.mediaUrls.length > 0 ||
    rendered.kinds.length !== 1 ||
    rendered.kinds[0] !== "text"
  ) {
    opts.log.warn(
      `Delivery entry ${entry.id}: delivered during recovery; content could not be confirmed for the conversation`,
    );
    return;
  }
  try {
    const result = await commitConfirmedVisibleMessage({
      config: opts.cfg,
      channel: entry.channel,
      to: entry.to,
      accountId: entry.accountId,
      threadId: entry.threadId,
      producer: entry.session,
      expectedGeneration: entry.sessionGeneration
        ? {
            sessionKey: entry.sessionGeneration.sessionKey,
            sessionId: entry.sessionGeneration.sessionId,
            lifecycleRevision: entry.sessionGeneration.lifecycleRevision ?? undefined,
          }
        : undefined,
      payload: { text: prepared.payload.text },
      deliveryId: entry.id,
      payloadIndex: prepared.sourceIndex,
      assertCurrent: () => stateContext.workerContext.admission.assertCurrent(),
      assertDirectAdapterHandoff: () => stateContext.workerContext.admission.assertCurrent(),
      stateDir: stateContext.stateDir,
    });
    const diagnostic = result.ok ? result.diagnostics : result.reason;
    if (diagnostic) {
      opts.log.warn(`Delivery entry ${entry.id} confirmed transcript: ${diagnostic}`);
    }
  } catch (error) {
    // Confirmation has already ended queue custody. Bookkeeping failure must
    // never turn the visible send into a retry.
    opts.log.warn(
      `Delivery entry ${entry.id} confirmed transcript commit failed: ${formatErrorMessage(error)}`,
    );
  }
}
