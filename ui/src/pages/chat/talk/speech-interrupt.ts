import { measureRealtimeTalkAudioFrame, RealtimeTalkPcmInputPump } from "./audio.ts";
import { RealtimeTalkInputOwner } from "./input.ts";

export type PlaybackSpeechInterruptOptions = {
  inputDeviceId?: string;
  /** RMS level treated as speech. Matches the dictation silence detector's floor. */
  threshold?: number;
  /** Sustained speech required before barging in, so transient noise does not cut playback. */
  debounceMs?: number;
};

/** Live microphone stream plus the buffered audio that triggered the interrupt. */
export type SpeechInterruptHandoff = {
  stream: MediaStream;
  buffered: Float32Array[];
};

const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_DEBOUNCE_MS = 160;
// Match the dictation pipeline so buffered onset audio transcribes at the right rate.
const SAMPLE_RATE_HZ = 8000;
const MAX_BUFFER_SECONDS = 2;

/**
 * Local-only microphone speech detector for split Talk barge-in.
 *
 * Split Talk finishes dictation before it plays the reply, so nothing listens
 * while the assistant speaks. This monitor opens the microphone during playback
 * and fires once the user speaks over the reply. It keeps a rolling buffer of the
 * triggering audio and its live stream so the transport can hand both to the next
 * capture: the interrupting correction keeps recording with no microphone gap and
 * is not lost while the next transcription session is admitted. It never sends
 * audio to the Gateway itself; echo cancellation plus a sustained-speech debounce
 * keep speaker bleed from triggering a false interrupt.
 */
export class PlaybackSpeechInterrupt {
  private readonly input = new RealtimeTalkInputOwner(() => this.stop());
  private readonly pump = new RealtimeTalkPcmInputPump();
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private readonly buffer: Float32Array[] = [];
  private bufferedSamples = 0;
  private loudSamples = 0;
  private fired = false;
  private stopped = false;
  private handedOff = false;
  private canHandoff = false;

  constructor(
    private readonly onInterrupt: () => void,
    private readonly options: PlaybackSpeechInterruptOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.stopped) {
      return;
    }
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE_HZ });
    } catch {
      // Without Web Audio there is no level signal; playback proceeds uninterrupted.
      return;
    }
    this.context = context;
    // Only a matching sample rate lets the buffered onset join the dictation pipeline.
    this.canHandoff = context.sampleRate === SAMPLE_RATE_HZ;
    let media: MediaStream;
    try {
      media = await this.input.open(this.options.inputDeviceId);
    } catch {
      // A microphone that cannot reopen must not fail the reply that is playing.
      this.stop();
      return;
    }
    if (this.stopped) {
      return;
    }
    this.stream = media;
    const threshold = this.options.threshold ?? DEFAULT_THRESHOLD;
    const debounceSamples =
      ((this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS) * context.sampleRate) / 1000;
    const maxBufferSamples = MAX_BUFFER_SECONDS * context.sampleRate;
    this.pump.start(media, context, (samples) => {
      if (this.stopped || this.fired) {
        return;
      }
      this.buffer.push(samples.slice());
      this.bufferedSamples += samples.length;
      while (this.bufferedSamples > maxBufferSamples && this.buffer.length > 1) {
        const removed = this.buffer.shift();
        if (removed) {
          this.bufferedSamples -= removed.length;
        }
      }
      if (measureRealtimeTalkAudioFrame(samples).rms >= threshold) {
        this.loudSamples += samples.length;
        if (this.loudSamples >= debounceSamples) {
          this.fired = true;
          this.onInterrupt();
        }
      } else {
        this.loudSamples = 0;
      }
    });
  }

  /**
   * Releases the live stream and buffered onset to the next capture. Returns null
   * when no interrupt fired or the sample rate cannot join the dictation pipeline,
   * in which case the transport falls back to opening a fresh microphone.
   */
  handoff(): SpeechInterruptHandoff | null {
    if (!this.canHandoff || !this.stream || this.handedOff || !this.fired) {
      return null;
    }
    this.handedOff = true;
    this.pump.stop();
    const buffered = this.buffer.splice(0);
    this.bufferedSamples = 0;
    return { stream: this.stream, buffered };
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.pump.stop();
    // After handoff the next capture owns the stream; only release it otherwise.
    // input.stop() also aborts a microphone acquisition still awaiting permission.
    if (!this.handedOff) {
      this.input.stop();
    }
    void this.context?.close();
    this.context = null;
  }
}
