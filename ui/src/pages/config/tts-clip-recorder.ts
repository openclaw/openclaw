import { encodeWavPcm16Mono, floatToPcm16, resampleFloat32Mono } from "../../lib/pcm-wav.ts";
import { RealtimeTalkPcmInputPump } from "../chat/talk/audio.ts";
import { RealtimeTalkInputController } from "../chat/talk/input.ts";

export const TTS_CLIP_TARGET_SAMPLE_RATE_HZ = 24_000;
export const TTS_CLIP_MAX_DURATION_MS = 30_000;

export type TtsRecordedClip = {
  wav: Uint8Array;
  mimeType: "audio/wav";
  durationMs: number;
  sampleRate: number;
};

export class TtsClipRecorderCancelledError extends Error {
  constructor() {
    super("Voice clip recording was cancelled");
    this.name = "TtsClipRecorderCancelledError";
  }
}

export class TtsClipRecorder {
  private input: RealtimeTalkInputController | null = null;
  private context: AudioContext | null = null;
  private pump: RealtimeTalkPcmInputPump | null = null;
  private chunks: Float32Array[] = [];
  private startedAtMs = 0;
  private onLevel: ((level: number) => void) | undefined;
  private startGeneration = 0;

  get recording(): boolean {
    return this.context !== null;
  }

  get elapsedMs(): number {
    if (!this.startedAtMs) {
      return 0;
    }
    return Math.max(0, Date.now() - this.startedAtMs);
  }

  async start(
    options: {
      deviceId?: string;
      onLevel?: (level: number) => void;
    } = {},
  ): Promise<void> {
    this.dispose();
    const generation = this.startGeneration + 1;
    this.startGeneration = generation;
    this.onLevel = options.onLevel;
    const input = new RealtimeTalkInputController(() => undefined);
    let media: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      media = await input.open(options.deviceId);
      if (generation !== this.startGeneration) {
        throw new TtsClipRecorderCancelledError();
      }
      context = new AudioContext({ sampleRate: TTS_CLIP_TARGET_SAMPLE_RATE_HZ });
      if (context.state === "suspended") {
        await context.resume();
      }
      if (generation !== this.startGeneration) {
        throw new TtsClipRecorderCancelledError();
      }
      this.input = input;
      this.context = context;
      this.chunks = [];
      this.pump = new RealtimeTalkPcmInputPump();
      this.pump.start(media, context, (samples) => {
        this.chunks.push(new Float32Array(samples));
        this.onLevel?.(peakLevel(samples));
      });
      this.startedAtMs = Date.now();
    } catch (error) {
      if (this.input !== input) {
        media?.getTracks().forEach((track) => track.stop());
        input.stop();
        void context?.close();
      }
      throw error;
    }
  }

  async stop(): Promise<TtsRecordedClip> {
    const context = this.context;
    if (!context) {
      throw new Error("No voice clip is being recorded");
    }
    const nativeRate = context.sampleRate || TTS_CLIP_TARGET_SAMPLE_RATE_HZ;
    const chunks = this.chunks;
    this.teardownGraph();
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const pcm = resampleFloat32Mono(samples, nativeRate, TTS_CLIP_TARGET_SAMPLE_RATE_HZ);
    return {
      wav: encodeWavPcm16Mono(floatToPcm16(pcm), TTS_CLIP_TARGET_SAMPLE_RATE_HZ),
      mimeType: "audio/wav",
      durationMs:
        TTS_CLIP_TARGET_SAMPLE_RATE_HZ > 0
          ? (pcm.length / TTS_CLIP_TARGET_SAMPLE_RATE_HZ) * 1000
          : 0,
      sampleRate: TTS_CLIP_TARGET_SAMPLE_RATE_HZ,
    };
  }

  dispose(): void {
    this.startGeneration += 1;
    this.teardownGraph();
  }

  private teardownGraph(): void {
    this.pump?.stop();
    this.pump = null;
    void this.context?.close();
    this.context = null;
    this.startedAtMs = 0;
    this.input?.stop();
    this.input = null;
    this.chunks = [];
    this.onLevel?.(0);
    this.onLevel = undefined;
  }
}

function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    if (absolute > peak) {
      peak = absolute;
    }
  }
  return peak;
}
