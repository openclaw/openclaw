import { measureRealtimeTalkAudioFrame, RealtimeTalkPcmInputPump } from "./audio.ts";
import { RealtimeTalkInputOwner } from "./input.ts";

export type PlaybackSpeechInterruptOptions = {
  inputDeviceId?: string;
  /** RMS level treated as speech. Matches the dictation silence detector's floor. */
  threshold?: number;
  /** Sustained speech required before barging in, so transient noise does not cut playback. */
  debounceMs?: number;
};

const DEFAULT_THRESHOLD = 0.02;
const DEFAULT_DEBOUNCE_MS = 160;

/**
 * Local-only microphone speech detector for split Talk barge-in.
 *
 * Split Talk finishes dictation before it plays the reply, so nothing listens
 * while the assistant speaks. This monitor opens the microphone during playback
 * and fires once the user speaks over the reply, letting the transport cut the
 * audio and listen again. It never transcribes or sends audio to the Gateway;
 * echo cancellation plus a sustained-speech debounce keep speaker bleed from
 * triggering a false interrupt.
 */
export class PlaybackSpeechInterrupt {
  private readonly input = new RealtimeTalkInputOwner(() => this.stop());
  private readonly pump = new RealtimeTalkPcmInputPump();
  private context: AudioContext | null = null;
  private loudSamples = 0;
  private fired = false;
  private stopped = false;

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
      context = new AudioContext();
    } catch {
      // Without Web Audio there is no level signal; playback proceeds uninterrupted.
      return;
    }
    this.context = context;
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
    const threshold = this.options.threshold ?? DEFAULT_THRESHOLD;
    const debounceSamples =
      ((this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS) * context.sampleRate) / 1000;
    this.pump.start(media, context, (samples) => {
      if (this.stopped || this.fired) {
        return;
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

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.input.stop();
    this.pump.stop();
    void this.context?.close();
    this.context = null;
  }
}
