import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCallbacks,
} from "./provider-types.js";

export type FiniteRealtimeTranscriptionSessionOptions = {
  callbacks: RealtimeTranscriptionSessionCallbacks;
  signal: AbortSignal;
  /** Provider-chosen segment bound below any upstream automatic commit threshold. */
  segmentBytes: number;
  frameBytes: number;
  /** PCM sample boundaries may span caller chunks, but never provider frames. */
  alignmentBytes?: number;
  maxQueuedBytes?: number;
  commitTimeoutMs?: number;
  createSession: (callbacks: RealtimeTranscriptionSessionCallbacks) => {
    session: RealtimeTranscriptionSession;
    /** Must acknowledge exactly once through onTranscript, including empty text. */
    commit: () => void;
  };
};

/**
 * One finite input over a provider session. Serialized segment acknowledgments keep
 * the final result tied to every accepted byte, rather than whichever final arrives
 * first after the caller stops speaking. Providers own framing and segment limits.
 */
export function createFiniteRealtimeTranscriptionSession(
  options: FiniteRealtimeTranscriptionSessionOptions,
): RealtimeTranscriptionSession & {
  writeAudio(audio: Buffer): Promise<void>;
  finishInput(): Promise<{ text: string }>;
} {
  const owner = getPluginRuntimeGatewayRequestScope()?.transcriptionOwner;
  const alignment = options.alignmentBytes ?? 1;
  if (
    !Number.isSafeInteger(options.segmentBytes) ||
    options.segmentBytes <= 0 ||
    !Number.isSafeInteger(options.frameBytes) ||
    options.frameBytes <= 0 ||
    !Number.isSafeInteger(alignment) ||
    alignment <= 0 ||
    options.segmentBytes % alignment !== 0 ||
    options.frameBytes % alignment !== 0
  ) {
    throw new Error("Finite transcription requires positive frame and segment byte limits");
  }
  let failure: Error | undefined;
  let connected = false;
  let finished = false;
  let finishRequested = false;
  let connectPromise: Promise<void> | undefined;
  let finishPromise: Promise<{ text: string }> | undefined;
  let queuedBytes = 0;
  let segmentBytes = 0;
  let remainder = Buffer.alloc(0);
  let serial = Promise.resolve();
  const transcripts: string[] = [];
  let pendingCommit:
    | {
        resolve: (text: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  function abortError(): Error {
    const error = new Error("Finite transcription aborted");
    error.name = "AbortError";
    return error;
  }

  function fail(error: Error): void {
    if (failure || finished) {
      return;
    }
    failure = error;
    connected = false;
    options.signal.removeEventListener("abort", onAbort);
    const pending = pendingCommit;
    pendingCommit = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    backend.session.close();
    try {
      options.callbacks.onError?.(error);
    } catch {
      // Diagnostic observers must not replace the terminal request failure.
    }
  }

  function onAbort(): void {
    fail(abortError());
  }

  function assertActive(): void {
    options.signal.throwIfAborted();
    owner?.assertCurrent();
    if (failure) {
      throw failure;
    }
    if (finished) {
      throw new Error("Finite transcription is complete");
    }
  }

  const backend = options.createSession({
    onPartial: (text) => {
      if (!failure && !finished) {
        options.callbacks.onPartial?.(text);
      }
    },
    onSpeechStart: () => {
      if (!failure && !finished) {
        options.callbacks.onSpeechStart?.();
      }
    },
    onError: fail,
    onTranscript: (text) => {
      if (failure || finished) {
        return;
      }
      const pending = pendingCommit;
      if (!pending) {
        fail(new Error("Unexpected finite transcription segment without a pending commit"));
        return;
      }
      pendingCommit = undefined;
      clearTimeout(pending.timer);
      pending.resolve(text);
      options.callbacks.onTranscript?.(text);
    },
  });

  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) {
    onAbort();
  }

  async function commit(): Promise<void> {
    assertActive();
    if (segmentBytes === 0) {
      return;
    }
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error("Finite transcription commit timed out")),
        options.commitTimeoutMs ?? 30_000,
      );
      pendingCommit = { resolve, reject, timer };
      try {
        backend.commit();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    assertActive();
    transcripts.push(text);
    segmentBytes = 0;
  }

  const session = {
    connect() {
      connectPromise ??= (async () => {
        assertActive();
        try {
          await backend.session.connect();
          assertActive();
          connected = true;
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          fail(normalized);
          throw failure ?? normalized;
        }
      })();
      return connectPromise;
    },
    writeAudio(audio: Buffer) {
      try {
        assertActive();
        if (finishRequested) {
          throw new Error("Finite transcription input is already finished");
        }
        if (!connected) {
          throw new Error("Finite transcription must connect before sending audio");
        }
        if (queuedBytes + audio.byteLength > (options.maxQueuedBytes ?? 2 * 1024 * 1024)) {
          const error = new Error("Finite transcription audio queue exceeded its byte limit");
          fail(error);
          throw error;
        }
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // Snapshot at admission; callers may recycle their capture buffer while queued.
      const accepted = Buffer.from(audio);
      queuedBytes += accepted.byteLength;
      const operation = serial
        .then(async () => {
          assertActive();
          const input = remainder.length > 0 ? Buffer.concat([remainder, accepted]) : accepted;
          const alignedLength = input.length - (input.length % alignment);
          remainder = Buffer.from(input.subarray(alignedLength));
          for (let offset = 0; offset < alignedLength;) {
            const count = Math.min(
              options.frameBytes,
              options.segmentBytes - segmentBytes,
              alignedLength - offset,
            );
            assertActive();
            backend.session.sendAudio(input.subarray(offset, offset + count));
            assertActive();
            offset += count;
            segmentBytes += count;
            if (segmentBytes === options.segmentBytes) {
              await commit();
            }
          }
        })
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          fail(normalized);
          throw failure ?? normalized;
        })
        .finally(() => {
          queuedBytes -= accepted.byteLength;
        });
      // Keep the scheduling tail observed even if a caller forgets to await it.
      serial = operation.catch(() => {});
      return operation;
    },
    finishInput() {
      finishRequested = true;
      finishPromise ??= serial
        .then(async () => {
          assertActive();
          if (!connected) {
            throw new Error("Finite transcription must connect before finishing input");
          }
          if (remainder.length > 0) {
            throw new Error("Finite transcription input ends with an incomplete audio sample");
          }
          await commit();
          assertActive();
          finished = true;
          connected = false;
          options.signal.removeEventListener("abort", onAbort);
          backend.session.close();
          return { text: transcripts.filter((text) => text.length > 0).join(" ") };
        })
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          fail(normalized);
          throw failure ?? normalized;
        });
      return finishPromise;
    },
    sendAudio(audio: Buffer) {
      // Preserve the synchronous continuous-session surface for callback consumers.
      // Finite consumers use writeAudio to observe backpressure and rejection.
      void session.writeAudio(audio).catch(() => {});
    },
    close() {
      if (!finished) {
        fail(abortError());
      }
    },
    isConnected: () => connected && !failure && !finished,
  };
  return session;
}
