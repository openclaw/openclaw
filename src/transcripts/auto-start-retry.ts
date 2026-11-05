import {
  activeSessions,
  retainTranscriptStartRetry,
  TranscriptStartError,
  type TranscriptStartRetry,
} from "./capture-startup.js";
import { isTranscriptSessionStarting } from "./capture.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsSummaryChangedError } from "./store-errors.js";
import { transcriptSessionSelector, type TranscriptsStore } from "./store.js";

/** Own one configured entry's failed admission through retry and abandonment. */
export function createTranscriptAutoStartRetry(params: {
  stateDir: string;
  store: TranscriptsStore;
  warn: (error: unknown) => void;
}) {
  let current: TranscriptStartRetry | undefined;
  const clear = () => {
    current?.release();
    current = undefined;
  };
  return {
    get current() {
      return current;
    },
    clear,
    async retainFailure(
      error: TranscriptStartError,
      previous: TranscriptStartRetry | undefined,
      existingSession: TranscriptSessionDescriptor | undefined,
    ) {
      const retry = error.retry;
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
      } catch (retentionError) {
        clear();
        throw retentionError;
      }
      if (
        !previous &&
        existingSession &&
        error.code === "id-conflict" &&
        error.cause instanceof TranscriptsSummaryChangedError &&
        !(await params.store.readSession(transcriptSessionSelector(existingSession)))
      ) {
        // A retiring service may discard a merely selected candidate before
        // admission. Rescan on the normal bounded retry; never revive the row.
        throw new Error("transcript reopen candidate was discarded before admission", {
          cause: error,
        });
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
