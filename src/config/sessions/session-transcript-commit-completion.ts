import type {
  SessionTranscriptTurnPersistOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";

/** Accept every synchronous callback before yielding, then join its explicit committed work. */
export function completeSessionTranscriptCommit(
  messages: readonly TranscriptMessageAppendResult<unknown>[],
  onMessageCommitted: SessionTranscriptTurnPersistOptions["onMessageCommitted"],
): Promise<void> | undefined {
  if (!onMessageCommitted) {
    return undefined;
  }
  const pending: Promise<void>[] = [];
  let accepting = true;
  let failed = false;
  let failure: unknown;
  const accept = (complete: () => Promise<void>) => {
    if (!accepting) {
      throw new Error("Transcript committed completion admission is closed");
    }
    const completion = complete();
    void completion.catch(() => undefined);
    pending.push(completion);
  };
  try {
    for (const message of messages) {
      onMessageCommitted(message, accept);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    accepting = false;
  }
  if (pending.length === 0) {
    if (failed) {
      throw failure;
    }
    return undefined;
  }
  return Promise.allSettled(pending).then((results) => {
    if (failed) {
      throw failure;
    }
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  });
}
