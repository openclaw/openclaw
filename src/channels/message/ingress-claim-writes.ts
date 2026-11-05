/** Bounded claim-token-fenced writes for durable ingress settlement. */
import { sleepWithAbort } from "@openclaw/retry";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { IngressAdoptionLostError, isIngressAdoptionLostError } from "./ingress-drain-state.js";
import type { ChannelIngressQueue, ChannelIngressQueueClaim } from "./ingress-queue.types.js";
import {
  DEFAULT_INGRESS_RETRY_BASE_MS,
  DEFAULT_INGRESS_RETRY_MAX_MS,
} from "./ingress-retry-policy.js";

/** Bounded tombstone write retries — wedged ownership beats silent double-dispatch. */
const INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS = 8;

/**
 * Claim-token fenced writes can throw OR return false when the lease was
 * reclaimed. For complete, false is ownership loss (do not settle success).
 * For release/fail, false means the row is already gone from this owner —
 * treat as done so abandon races do not wedge.
 */
export function createIngressWriter<TPayload, TMetadata, TCompletedMetadata>(
  options: { abortSignal?: AbortSignal },
  {
    queue,
    now,
    formatError,
    log,
    isStopped,
    isDisposed,
    onTerminal,
  }: {
    queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>;
    now: () => number;
    formatError: (err: unknown) => string;
    log: (message: string) => void;
    isStopped: () => boolean;
    isDisposed: () => boolean;
    onTerminal: (id: string) => void;
  },
) {
  const commitClaimWriteWithRetry = async (params: {
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
    label: "tombstone" | "dead-letter" | "release";
    write: () => Promise<boolean>;
    falseMeansReclaimed: boolean;
    retryOnShutdown?: boolean;
  }): Promise<boolean> => {
    const maxAttempts = params.retryOnShutdown ? 3 : INGRESS_TOMBSTONE_RETRY_MAX_ATTEMPTS;
    const shouldStop = params.retryOnShutdown ? isDisposed : isStopped;
    let attempt = 0;
    for (;;) {
      // First write still runs after session abort: terminal complete/release
      // (failed-retryable requeue, post-dispatch tombstone) must not be blocked.
      // Stop only cuts retry backoffs (webhook stop / dispose mid-retry).
      if (attempt > 0 && shouldStop()) {
        throw new Error("ingress drain stopped during claim write");
      }
      try {
        const committed = await params.write();
        if (!committed && params.falseMeansReclaimed) {
          throw new IngressAdoptionLostError("reclaimed");
        }
        return committed;
      } catch (err) {
        if (isIngressAdoptionLostError(err) || hasSqliteWorkerOutcomeUnknown(err)) {
          if (params.retryOnShutdown) {
            log(
              `ingress drain: cancelled release write failed for event ${params.claim.id}; holding claim: ${formatError(err)}`,
            );
          }
          throw err;
        }
        attempt += 1;
        if (shouldStop() || attempt >= maxAttempts) {
          if (attempt >= maxAttempts && !shouldStop()) {
            log(
              `ingress drain: ${params.label} write failed for event ${params.claim.id} after ${attempt} attempt(s); holding claim: ${formatError(err)}`,
            );
          }
          throw err;
        }
        const delayMs = Math.min(
          DEFAULT_INGRESS_RETRY_MAX_MS,
          DEFAULT_INGRESS_RETRY_BASE_MS * 2 ** (attempt - 1),
        );
        const displayId = params.claim.id.replace(/^0+(?=\d)/, "") || params.claim.id;
        // Operator + test-visible: tombstone/complete retries after durable adoption.
        log(
          `ingress drain: ${params.label} retry ${attempt}/${maxAttempts} for event ${params.claim.id} in ${delayMs}ms: ${formatError(err)}`,
        );
        if (params.label === "tombstone") {
          log(`completion retry ${attempt} scheduled for event ${displayId}`);
        }
        // Retained cancellation joins a short release retry even after session abort.
        // Explicit disposal still stops the next attempt; other writes remain abortable.
        await sleepWithAbort(delayMs, params.retryOnShutdown ? undefined : options.abortSignal, {
          ref: false,
        });
      }
    }
  };

  const completeClaimWithRetry = async (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
  ): Promise<void> => {
    // Tombstone via complete() — never delete. Retry IO failures; false = reclaimed.
    await commitClaimWriteWithRetry({
      claim,
      label: "tombstone",
      write: () => queue.complete(claim),
      falseMeansReclaimed: true,
    });
    onTerminal(claim.id);
  };

  const releaseClaim = (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    releaseOptions?: { lastError?: string; recordAttempt?: boolean; retryOnShutdown?: boolean },
  ) =>
    commitClaimWriteWithRetry({
      claim,
      label: "release",
      retryOnShutdown: releaseOptions?.retryOnShutdown,
      write: () =>
        queue.release(claim, {
          lastError: releaseOptions?.lastError,
          recordAttempt: releaseOptions?.recordAttempt,
          releasedAt: now(),
        }),
      falseMeansReclaimed: false,
    });

  const failClaim = (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    reason: string,
    message: string,
  ) =>
    commitClaimWriteWithRetry({
      claim,
      label: "dead-letter",
      write: () => queue.fail(claim, { reason, message, failedAt: now() }),
      // Fail false after guillotine/supersede race: treat as already settled.
      falseMeansReclaimed: false,
    }).then((committed) => {
      onTerminal(claim.id);
      return committed;
    });

  return { completeClaimWithRetry, releaseClaim, failClaim };
}
