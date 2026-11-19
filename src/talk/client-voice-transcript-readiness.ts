import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { materializeErrorStack } from "../infra/error-graph-internal.js";

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
      materializeErrorStack(error);
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
