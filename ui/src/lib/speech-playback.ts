import type { TtsSpeakResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { DEFAULT_MAX_TEXT_LENGTH } from "../../../src/tts/tts-limits.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { base64ToBytes } from "./bytes-base64.ts";
import { listen } from "./reactive/listener.ts";

const activePlayback = new WeakMap<GatewayBrowserClient, GatewaySpeechPlayback>();

export function resolveSpeechTextLimit(config: unknown): number {
  const limit = asOptionalRecord(asOptionalRecord(config)?.tts)?.maxTextLength;
  return typeof limit === "number" ? limit : DEFAULT_MAX_TEXT_LENGTH;
}

/** Browser playback only; the Gateway owns provider selection and synthesis. */
/** A streamed speech segment; aborting its signal withdraws it if it has not started playing. */
export type SpeechSegment = string | { text: string; signal?: AbortSignal };

export class GatewaySpeechPlayback {
  private generation = 0;
  private finish: (() => void) | undefined;
  private audio: HTMLAudioElement | undefined;
  private ready: Promise<void> | undefined;
  private client: GatewayBrowserClient | undefined;
  private superseded: (() => void) | undefined;
  private cancel: (() => void) | undefined;

  prepare(client?: GatewayBrowserClient, superseded?: () => void): HTMLAudioElement {
    if (client) {
      const previous = activePlayback.get(client);
      if (previous !== this) {
        const onSuperseded = previous?.superseded;
        previous?.stop();
        onSuperseded?.();
        activePlayback.set(client, this);
      }
      this.client = client;
    }
    this.superseded = superseded ?? this.superseded;
    if (this.audio) {
      return this.audio;
    }
    // Safari grants playback to an element during a gesture, before synthesis awaits.
    const audio = new Audio(
      "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQIAAAAAAA==",
    );
    this.audio = audio;
    this.ready = audio.play().then(
      () => audio.pause(),
      () => undefined,
    );
    return audio;
  }

  stop(): void {
    this.cancelPlayback();
    if (this.client && activePlayback.get(this.client) === this) {
      activePlayback.delete(this.client);
    }
    this.superseded = undefined;
  }

  private cancelPlayback(): void {
    this.generation += 1;
    this.cancel?.();
    this.cancel = undefined;
    this.finish?.();
  }

  async speak(
    client: GatewayBrowserClient,
    text: string | ReadableStream<SpeechSegment>,
    method: "tts.speak" | "talk.speak" = "tts.speak",
    isCurrent: () => boolean = () => true,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  ): Promise<void> {
    this.cancelPlayback();
    const audio = this.prepare(client);
    const generation = this.generation;
    const controller = new AbortController();
    const cancelled = new Promise<undefined>((resolve) => {
      this.cancel = () => {
        controller.abort();
        resolve(undefined);
      };
    });
    const reader = typeof text === "string" ? undefined : text.getReader();
    try {
      const { chunkText } = await import("../../../packages/markdown-core/src/chunk-text.js");
      const chunks: Array<{ text: string; signal?: AbortSignal }> =
        typeof text === "string"
          ? chunkText(text, maxTextLength).map((chunk) => ({ text: chunk }))
          : [];
      const current = () => generation === this.generation && isCurrent();
      const synthesizeNext = async () => {
        while (current()) {
          const chunk = chunks.shift();
          if (chunk !== undefined) {
            if (chunk.signal?.aborted) {
              continue; // The producer withdrew this segment.
            }
            const params = { text: chunk.text };
            const signal = chunk.signal
              ? AbortSignal.any([controller.signal, chunk.signal])
              : controller.signal;
            try {
              const result = await (reader
                ? client.request<TtsSpeakResult>(method, params, { signal })
                : client.request<TtsSpeakResult>(method, params));
              return { result, signal: chunk.signal };
            } catch (error) {
              if (chunk.signal?.aborted && !controller.signal.aborted) {
                continue;
              }
              throw error;
            }
          }
          const next = reader && (await Promise.race([reader.read(), cancelled]));
          if (!next || next.done) {
            return undefined;
          }
          const segment = typeof next.value === "string" ? { text: next.value } : next.value;
          for (const part of chunkText(segment.text, maxTextLength)) {
            chunks.push({ text: part, signal: segment.signal });
          }
        }
        return undefined;
      };
      let pending = synthesizeNext();
      while (current()) {
        const response = await Promise.race([pending, cancelled]);
        if (!response) {
          return;
        }
        await Promise.race([this.ready, cancelled]);
        if (!current()) {
          return;
        }
        if (response.signal?.aborted) {
          // The producer withdrew this clip while it waited behind the one playing.
          pending = synthesizeNext();
          void pending.catch(() => undefined);
          continue;
        }
        const playing = this.play(audio, response.result);
        if (reader) {
          pending = synthesizeNext();
          // A prefetched result can reject before the current clip finishes.
          void pending.catch(() => undefined);
        }
        await playing;
        if (!reader && current()) {
          pending = synthesizeNext();
        }
      }
    } finally {
      controller.abort();
      if (reader) {
        // Unblock an outstanding read without cancelling the producer's stream.
        reader.releaseLock();
      }
      if (generation === this.generation) {
        this.cancel = undefined;
      }
    }
  }

  private async play(audio: HTMLAudioElement, result: TtsSpeakResult): Promise<void> {
    const url = URL.createObjectURL(
      new Blob([base64ToBytes(result.audioBase64)], { type: result.mimeType }),
    );
    audio.src = url;
    audio.load();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (this.finish !== cancel) {
          return;
        }
        this.finish = undefined;
        stopEnded();
        stopError();
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const cancel = () => finish();
      const failed = () => finish(new Error("The browser could not play the generated speech."));
      this.finish = cancel;
      const stopEnded = listen(audio, "ended", cancel, { once: true });
      const stopError = listen(audio, "error", failed, { once: true });
      void audio
        .play()
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }
}
