import { raceWithTimeout } from "@openclaw/retry";
import { INGRESS_QUEUE_CAP_DROP_REASONS } from "./ingress-queue-cap-drop.js";
import type { ChannelIngressQueueClaim } from "./ingress-queue.types.js";
import type { IngressNonRetryableFailure } from "./ingress-retry-policy.js";

export type IngressDeadLetterNotice<TPayload, TMetadata> = (
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
  failure: IngressNonRetryableFailure,
  signal: AbortSignal,
) => void | Promise<void>;

/** Report committed failure outcomes; only delivery failures can notify the transport. */
export function createIngressFailureReporter<TPayload, TMetadata>(
  onDeadLetter: IngressDeadLetterNotice<TPayload, TMetadata> | undefined,
  log: (message: string) => void,
  formatError: (error: unknown) => string,
) {
  return async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    failure: IngressNonRetryableFailure & { attempt: number },
  ) => {
    const displayId = claim.id.replace(/^0+(?=\d)/, "") || claim.id;
    if (INGRESS_QUEUE_CAP_DROP_REASONS.some((reason) => reason === failure.reason)) {
      log(
        `spooled update ${displayId} on lane ${claim.laneKey ?? displayId} dropped by queue policy (${failure.reason})`,
      );
      return;
    }
    log(
      `spooled update ${displayId} on lane ${claim.laneKey ?? displayId} failed after ${failure.attempt} attempts (${failure.reason}): ${failure.message}; dead-lettered`,
    );
    if (!onDeadLetter) {
      return;
    }
    const controller = new AbortController();
    try {
      await raceWithTimeout(
        () => Promise.resolve(onDeadLetter(claim, failure, controller.signal)),
        15_000,
        () => {
          const error = new Error("dead-letter notice timed out after 15000ms");
          controller.abort(error);
          throw error;
        },
        { ref: false },
      );
    } catch (error) {
      log(`spooled update ${displayId} dead-letter notice failed: ${formatError(error)}`);
    }
  };
}
