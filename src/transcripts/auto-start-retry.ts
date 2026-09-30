import { retainTranscriptStartRetry, TranscriptStartError } from "./capture-startup.js";
import { activeSessions, isTranscriptSessionStarting } from "./capture.js";
import { TranscriptsSummaryChangedError } from "./store-errors.js";
import type { TranscriptsStore } from "./store.js";

type Retry = ReturnType<typeof retainTranscriptStartRetry>;

/** Own one configured entry's failed admission through retry and abandonment. */
export function createTranscriptAutoStartRetry(params: {
  stateDir: string;
  store: TranscriptsStore;
  warn: (error: unknown) => void;
}) {
  let current: Retry | undefined;
  const clear = () => {
    current?.release();
    current = undefined;
  };
  return {
    get current() {
      return current;
    },
    clear,
    retain(retry: TranscriptStartError["retry"], previous: Retry | undefined) {
      try {
        if (retry) {
          // Retries update an existing row; insertion provenance remains with the
          // same live admission even when startup settles during shutdown.
          previous?.assertCurrent();
          const discardOnAbandon =
            retry.discardOnAbandon ||
            (previous?.discardOnAbandon === true &&
              previous.session.sessionId === retry.session.sessionId &&
              previous.session.startedAt === retry.session.startedAt);
          clear();
          current = retainTranscriptStartRetry(params.stateDir, { ...retry, discardOnAbandon });
        } else {
          clear();
        }
      } catch (error) {
        clear();
        throw error;
      }
    },
    async discard() {
      const retry = current;
      if (!retry) {
        return;
      }
      try {
        if (retry.discardOnAbandon) {
          await params.store.deleteEmptySessionCandidate(retry.session, {
            expectedInputRevision: retry.revision,
            assertCurrent: () => {
              retry.assertCurrent();
              if (
                current !== retry ||
                activeSessions.has(retry.session.sessionId) ||
                isTranscriptSessionStarting(retry.session.sessionId)
              ) {
                throw new TranscriptStartError(
                  "id-conflict",
                  new Error("transcript candidate has a new capture owner"),
                );
              }
            },
          });
        }
      } catch (error) {
        // Revocation and changed state retire discard authority. Storage failures
        // remain visible without rejecting an unobserved timer callback.
        if (
          !(
            error instanceof TranscriptStartError || error instanceof TranscriptsSummaryChangedError
          )
        ) {
          params.warn(error);
        }
      } finally {
        retry.release();
        if (current === retry) {
          current = undefined;
        }
      }
    },
  };
}
