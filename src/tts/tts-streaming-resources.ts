import { AsyncLocalStorage } from "node:async_hooks";
import type { Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../infra/errors.js";
import { finishCapabilityOperation } from "../plugins/capability-provider-acquisition.js";
import type { SpeechSynthesisStreamResult } from "./provider-types.js";
import { throwTtsProjectionError } from "./tts-synthesis-support.js";

type SpeechWorkOwner = {
  run: <T>(operation: () => T | Promise<T>) => Promise<T>;
  release: () => Promise<void>;
};

export async function captureSpeechProviderStream(
  synthesis: SpeechSynthesisStreamResult,
  owner: SpeechWorkOwner,
) {
  const captured = AsyncLocalStorage.snapshot();
  const invoke = <T>(operation: () => T | Promise<T>) => captured(() => owner.run(operation));
  let source: ReadableStream<Uint8Array> | undefined;
  let providerRelease: (() => Promise<void>) | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed: Promise<Result<void, unknown>> | undefined;
  const releaseReader = (active: ReadableStreamDefaultReader<Uint8Array>) => {
    if (reader === active) {
      reader = undefined;
      active.releaseLock();
    }
  };
  let completion: Promise<PromiseSettledResult<void>> | undefined;
  const close = (reason?: unknown) =>
    (completion ??= Promise.resolve().then(async () => {
      const active = reader;
      // Request release can abort a retained tee; start it before waiting for cancellation.
      const cancellation = invoke(() => (active ? active.cancel(reason) : source?.cancel(reason)));
      const cleanup = invoke(() => providerRelease?.());
      if (active) {
        releaseReader(active);
      }
      const [canceled, cleaned] = await Promise.allSettled([cancellation, cleanup]);
      if (cleaned.status === "rejected") {
        throw cleaned.reason;
      }
      return canceled;
    }));
  try {
    // A failing stream getter must not hide its release callback, or vice versa.
    const [releaseField, streamField] = await Promise.allSettled([
      invoke(() => {
        providerRelease = synthesis.release;
      }),
      invoke(() => {
        source = synthesis.audioStream;
      }),
    ]);
    const failures: unknown[] = [streamField, releaseField].flatMap((field) =>
      field.status === "rejected" ? [field.reason] : [],
    );
    if (failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, formatErrorMessage(failures[0]), { cause: failures[0] });
    }
    reader = source?.getReader();
    closed = reader?.closed.then(
      () => ({ ok: true as const, value: undefined }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  } catch (error) {
    return await throwTtsProjectionError(error, async () => {
      await close(error);
    });
  }
  return {
    available: Boolean(source),
    requiresRelease: Boolean(providerRelease),
    closed,
    close,
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      const active = reader;
      if (!active) {
        return { done: true, value: undefined };
      }
      try {
        const chunk = await invoke(() => active.read());
        if (chunk.done) {
          releaseReader(active);
          source = undefined;
        }
        return chunk;
      } catch (error) {
        releaseReader(active);
        source = undefined;
        throw error;
      }
    },
  };
}

export function ownSpeechStream(
  transport: Awaited<ReturnType<typeof captureSpeechProviderStream>>,
  owner: SpeechWorkOwner,
) {
  let activePull: Promise<void> | undefined;
  const waitForPulls = async () => {
    while (activePull) {
      const pending = activePull;
      await pending;
      if (activePull === pending) {
        activePull = undefined;
      }
    }
  };
  let completion: Promise<PromiseSettledResult<void>> | undefined;
  const finish = (reason?: unknown) =>
    (completion ??= Promise.resolve().then(async () => {
      // Start transport cancellation before joining a read it may need to unblock.
      const [closing, pulling] = await Promise.allSettled([
        transport.close(reason),
        waitForPulls(),
      ]);
      let outcome: Result<PromiseSettledResult<void>, unknown>;
      if (closing.status === "rejected") {
        outcome = {
          ok: false,
          error:
            pulling.status === "rejected"
              ? new AggregateError(
                  [closing.reason, pulling.reason],
                  formatErrorMessage(closing.reason),
                  { cause: closing.reason },
                )
              : closing.reason,
        };
      } else if (pulling.status === "rejected") {
        outcome = { ok: false, error: pulling.reason };
      } else {
        outcome = { ok: true, value: closing.value };
      }
      return await finishCapabilityOperation(outcome, owner.release);
    }));
  let terminal = false;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  const audioStream = transport.available
    ? new ReadableStream<Uint8Array>(
        {
          start(controller) {
            output = controller;
          },
          pull(controller) {
            const pending = (async () => {
              try {
                const chunk = await transport.read();
                if (terminal) {
                  return;
                }
                if (chunk.done) {
                  if (transport.requiresRelease) {
                    terminal = true;
                    controller.close();
                  }
                } else {
                  controller.enqueue(chunk.value);
                }
              } catch (error) {
                if (!terminal && transport.requiresRelease) {
                  terminal = true;
                  controller.error(error);
                }
              }
            })();
            activePull = pending;
            return pending;
          },
          async cancel(reason) {
            terminal = true;
            const canceled = await finish(reason);
            if (canceled.status === "rejected") {
              throw canceled.reason;
            }
          },
        },
        // Do not prefetch a returned but unopened stream.
        { highWaterMark: 0 },
      )
    : undefined;
  if (!transport.requiresRelease) {
    // Observe termination after handoff; never put this finalizer in the pull it joins.
    void transport.closed?.then(async (ending) => {
      if (terminal) {
        return;
      }
      try {
        await finish(ending.ok ? undefined : ending.error);
      } catch (error) {
        if (ending.ok && !terminal) {
          terminal = true;
          output?.error(error);
        }
      }
      if (!terminal) {
        terminal = true;
        if (ending.ok) {
          output?.close();
        } else {
          output?.error(ending.error);
        }
      }
    });
  }
  return {
    audioStream,
    async release() {
      if (!terminal) {
        terminal = true;
        output?.close();
      }
      await finish(new Error("TTS stream released"));
    },
  };
}
