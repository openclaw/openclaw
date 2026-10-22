import { AsyncLocalStorage } from "node:async_hooks";
import type { Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../infra/errors.js";
import { finishCapabilityOperation } from "../plugins/capability-provider-acquisition.js";
import type { SpeechSynthesisStreamResult } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { normalizeSpeechText } from "./speech-text.js";
import type { TtsStreamResult, TtsSynthesisStreamResult } from "./tts-runtime-types.js";
import {
  executeTtsProviderAttempts,
  acquireTtsRequest,
  throwTtsProjectionError,
} from "./tts-synthesis-support.js";
import { resolveTtsSynthesisTarget, type synthesizeSpeech } from "./tts-synthesis.js";

type SpeechSynthesisParams = Parameters<typeof synthesizeSpeech>[0];

export async function streamSpeech(
  params: SpeechSynthesisParams,
): Promise<TtsSynthesisStreamResult> {
  assertSpeechRuntimeAvailable();
  const acquired = await acquireTtsRequest({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if ("error" in acquired) {
    return { success: false, error: acquired.error };
  }

  const captureSpeechProviderStream = async (synthesis: SpeechSynthesisStreamResult) => {
    const captured = AsyncLocalStorage.snapshot();
    const invoke = <T>(operation: () => T | Promise<T>) => captured(() => acquired.run(operation));
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
        const cancellation = invoke(() =>
          active ? active.cancel(reason) : source?.cancel(reason),
        );
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
      await invoke(() => {
        providerRelease = synthesis.release;
        source = synthesis.audioStream;
      });
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
  };

  const ownSpeechStream = (transport: Awaited<ReturnType<typeof captureSpeechProviderStream>>) => {
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
        let cleanupOutcome: Result<PromiseSettledResult<void>, unknown>;
        if (closing.status === "rejected") {
          cleanupOutcome = {
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
          cleanupOutcome = { ok: false, error: pulling.reason };
        } else {
          cleanupOutcome = { ok: true, value: closing.value };
        }
        return await finishCapabilityOperation(cleanupOutcome, acquired.release);
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
  };

  let outcome: Result<TtsSynthesisStreamResult, unknown>;
  try {
    const result = await acquired.run(() => {
      const target = resolveTtsSynthesisTarget(params.channel);
      return executeTtsProviderAttempts({
        ...acquired.setup,
        synthesisText: normalizeSpeechText(params.text),
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        target,
        logLabel: "TTS stream",
        selectOperation: ({ provider, resolvedProvider }) => {
          if (!resolvedProvider.provider.streamSynthesize) {
            return {
              kind: "skip",
              reasonCode: "unsupported_for_streaming",
              message: `${provider} does not support streaming TTS`,
            };
          }
          return {
            kind: "ready",
            synthesize: async (request) => {
              const synthesis = await resolvedProvider.provider.streamSynthesize!(request);
              return {
                providerResult: synthesis,
                transport: await captureSpeechProviderStream(synthesis),
              };
            },
            cleanupFailedProjection: async ({ transport }) => {
              await transport.close();
            },
          };
        },
        buildSuccess: ({ synthesis: { providerResult, transport }, ...metadata }) => ({
          success: true as const,
          ...metadata,
          transport,
          outputFormat: providerResult.outputFormat,
          voiceCompatible: providerResult.voiceCompatible,
          fileExtension: providerResult.fileExtension,
          target,
        }),
      });
    });
    if (result.success) {
      const { transport, ...metadata } = result;
      return { ...metadata, ...ownSpeechStream(transport) };
    }
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}

export async function textToSpeechStream(params: SpeechSynthesisParams): Promise<TtsStreamResult> {
  const synthesis = await streamSpeech(params);
  if (!synthesis.success || !synthesis.audioStream || !synthesis.fileExtension) {
    await synthesis.release?.();
    return {
      success: false,
      error: synthesis.error ?? "Streaming TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }
  return synthesis;
}
