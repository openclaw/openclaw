const OUTPUT_AUDIO_FORMAT = {
  encoding: "pcm16le",
  sampleRateHz: 24_000,
  channels: 1,
} as const;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_BYTES_PER_MILLISECOND =
  (OUTPUT_AUDIO_FORMAT.sampleRateHz * OUTPUT_AUDIO_FORMAT.channels * PCM_BYTES_PER_SAMPLE) / 1000;
const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_AUDIO_BYTES = 1024 * 1024;

export type RealtimeVoiceOutputMediaState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export type RealtimeVoiceOutputMediaClearReason =
  | "barge-in"
  | "cancel"
  | "replace"
  | "hangup"
  | "error";

export type RealtimeVoiceOutputMediaEvent =
  | { type: "session.start"; generation: number; audio: typeof OUTPUT_AUDIO_FORMAT }
  | { type: "state"; generation: number; ptsMs: number; state: RealtimeVoiceOutputMediaState }
  | { type: "audio"; generation: number; sequence: number; ptsMs: number; pcm: Uint8Array }
  | { type: "clear"; generation: number; reason: RealtimeVoiceOutputMediaClearReason }
  | {
      type: "session.end";
      generation: number;
      reason: "completed" | "error" | "replaced";
    };

export type RealtimeVoiceOutputMediaSession = {
  readonly generation: number;
  clear(reason: RealtimeVoiceOutputMediaClearReason): number;
  end(reason: "completed" | "error" | "replaced"): void;
  sendAudio(pcm: Uint8Array, generation?: number): boolean;
  setState(state: RealtimeVoiceOutputMediaState, generation?: number): boolean;
};

type OutputListener = (event: RealtimeVoiceOutputMediaEvent) => void | Promise<void>;

class OutputMediaSession implements RealtimeVoiceOutputMediaSession {
  private active = true;
  private currentGeneration = 1;
  private stateGeneration = 1;
  private sequence = 0;
  private audioBytes = 0;
  private state: RealtimeVoiceOutputMediaState = "idle";
  private queue: RealtimeVoiceOutputMediaEvent[] = [];
  private queuedAudioBytes = 0;
  private draining = false;

  constructor(private readonly listener?: OutputListener) {
    this.publish({
      type: "session.start",
      generation: this.currentGeneration,
      audio: OUTPUT_AUDIO_FORMAT,
    });
    this.publish(this.stateEvent());
  }

  get generation(): number {
    return this.currentGeneration;
  }

  private ptsMs(): number {
    return this.audioBytes / PCM_BYTES_PER_MILLISECOND;
  }

  private stateEvent(): Extract<RealtimeVoiceOutputMediaEvent, { type: "state" }> {
    return {
      type: "state",
      generation: this.currentGeneration,
      ptsMs: this.ptsMs(),
      state: this.state,
    };
  }

  private publish(event: RealtimeVoiceOutputMediaEvent): void {
    if (!this.listener) {
      return;
    }
    if (event.type === "audio") {
      if (
        this.queue.length >= MAX_PENDING_EVENTS ||
        this.queuedAudioBytes + event.pcm.byteLength > MAX_PENDING_AUDIO_BYTES
      ) {
        return;
      }
      const copy = { ...event, pcm: Uint8Array.from(event.pcm) };
      this.queue.push(copy);
      this.queuedAudioBytes += copy.pcm.byteLength;
    } else {
      while (this.queue.length >= MAX_PENDING_EVENTS) {
        const audioIndex = this.queue.findIndex((queued) => queued.type === "audio");
        if (audioIndex < 0) {
          this.queue.shift();
          break;
        }
        const [removed] = this.queue.splice(audioIndex, 1);
        if (removed?.type === "audio") {
          this.queuedAudioBytes -= removed.pcm.byteLength;
        }
      }
      this.queue.push(event);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      while (this.listener) {
        const event = this.queue.shift();
        if (!event) {
          return;
        }
        if (event.type === "audio") {
          this.queuedAudioBytes -= event.pcm.byteLength;
        }
        try {
          await this.listener(event);
        } catch {
          // The session owner cannot interrupt provider playback.
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) {
        this.scheduleDrain();
      }
    }
  }

  setState(state: RealtimeVoiceOutputMediaState, generation = this.currentGeneration): boolean {
    if (!this.active || generation !== this.currentGeneration) {
      return false;
    }
    if (state === this.state && this.stateGeneration === this.currentGeneration) {
      return true;
    }
    this.state = state;
    this.stateGeneration = this.currentGeneration;
    this.publish(this.stateEvent());
    return true;
  }

  sendAudio(pcm: Uint8Array, generation = this.currentGeneration): boolean {
    if (!this.active || generation !== this.currentGeneration || pcm.byteLength === 0) {
      return false;
    }
    this.setState("speaking", generation);
    const event = {
      type: "audio" as const,
      generation: this.currentGeneration,
      sequence: this.sequence,
      ptsMs: this.ptsMs(),
      pcm,
    };
    this.sequence += 1;
    this.audioBytes += pcm.byteLength;
    this.publish(event);
    return true;
  }

  clear(reason: RealtimeVoiceOutputMediaClearReason): number {
    if (!this.active) {
      return this.currentGeneration;
    }
    this.currentGeneration += 1;
    this.stateGeneration = this.currentGeneration;
    this.sequence = 0;
    this.audioBytes = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (
        queued &&
        queued.generation < this.currentGeneration &&
        (queued.type === "audio" || queued.type === "state")
      ) {
        this.queue.splice(index, 1);
        if (queued.type === "audio") {
          this.queuedAudioBytes -= queued.pcm.byteLength;
        }
      }
    }
    this.publish({ type: "clear", generation: this.currentGeneration, reason });
    return this.currentGeneration;
  }

  end(reason: "completed" | "error" | "replaced"): void {
    if (!this.active) {
      return;
    }
    const clearReason = reason === "error" ? "error" : reason === "replaced" ? "replace" : "hangup";
    this.clear(clearReason);
    this.setState(reason === "error" ? "error" : "idle");
    this.active = false;
    this.publish({ type: "session.end", generation: this.currentGeneration, reason });
  }
}

export function createRealtimeVoiceOutputMediaSession(
  params: {
    onEvent?: OutputListener;
  } = {},
): RealtimeVoiceOutputMediaSession {
  return new OutputMediaSession(params.onEvent);
}
