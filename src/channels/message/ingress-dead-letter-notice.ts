import { raceWithTimeout } from "@openclaw/retry";
import type { ChannelIngressQueueClaim } from "./ingress-queue.types.js";
import type { IngressNonRetryableFailure } from "./ingress-retry-policy.js";

export type IngressDeadLetterNotice<TPayload, TMetadata> = (
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
  failure: IngressNonRetryableFailure,
  signal: AbortSignal,
) => void | Promise<void>;

/** Bound transport delivery after a committed dead letter; never retry the inbound event. */
export function createIngressDeadLetterNotifier<TPayload, TMetadata>(
  onDeadLetter: IngressDeadLetterNotice<TPayload, TMetadata> | undefined,
  log: (message: string) => void,
  formatError: (error: unknown) => string,
) {
  return async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    failure: IngressNonRetryableFailure,
  ) => {
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
      const displayId = claim.id.replace(/^0+(?=\d)/, "") || claim.id;
      log(`spooled update ${displayId} dead-letter notice failed: ${formatError(error)}`);
    }
  };
}
