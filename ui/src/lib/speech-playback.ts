import type { TtsSpeakResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { chunkText } from "../../../packages/markdown-core/src/chunk-text.js";
import { DEFAULT_MAX_TEXT_LENGTH } from "../../../src/tts/tts-limits.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { base64ToBytes } from "./bytes-base64.ts";

const activePlayback = new WeakMap<GatewayBrowserClient, GatewaySpeechPlayback>();

export function resolveSpeechTextLimit(config: unknown): number {
  const limit = asOptionalRecord(asOptionalRecord(config)?.tts)?.maxTextLength;
  return typeof limit === "number" ? limit : DEFAULT_MAX_TEXT_LENGTH;
}

/** Browser playback only; the Gateway owns provider selection and synthesis. */
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
    if (superseded) {
      this.superseded = superseded;
    }
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
    text: string,
    method: "tts.speak" | "talk.speak" = "tts.speak",
    isCurrent: () => boolean = () => true,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  ): Promise<void> {
    this.cancelPlayback();
    const audio = this.prepare(client);
    const generation = this.generation;
    const cancelled = new Promise<undefined>((resolve) => {
      this.cancel = () => resolve(undefined);
    });
    try {
      for (const textChunk of chunkText(text, maxTextLength)) {
        if (generation !== this.generation || !isCurrent()) {
          return;
        }
        const response = await Promise.race([
          client
            .request<TtsSpeakResult>(method, { text: textChunk })
            .then((result) => ({ result })),
          cancelled,
        ]);
        if (!response) {
          return;
        }
        await Promise.race([this.ready, cancelled]);
        if (generation !== this.generation || !isCurrent()) {
          return;
        }
        await this.play(audio, response.result);
      }
    } finally {
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
        audio.removeEventListener("ended", cancel);
        audio.removeEventListener("error", failed);
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
      audio.addEventListener("ended", cancel, { once: true });
      audio.addEventListener("error", failed, { once: true });
      void audio
        .play()
        .catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }
}
