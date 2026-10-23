import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";

/** Drain admitted transcript writes; speech text never creates execution authority. */
export function createClientVoiceTranscriptReadiness(params: {
  flushTranscript: () => Promise<void>;
}) {
  const lifetime = new AbortController();
  let failure: { error: unknown } | undefined;
  const throwIfFailed = () => {
    if (failure) {
      throw failure.error;
    }
  };
  return {
    fail(error: unknown): void {
      failure = { error };
    },
    async wait(signal?: AbortSignal): Promise<void> {
      const current = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
      current.throwIfAborted();
      throwIfFailed();
      await racePromiseWithAbortSignal(params.flushTranscript(), current);
      current.throwIfAborted();
      throwIfFailed();
    },
    close(): void {
      lifetime.abort();
    },
  };
}
