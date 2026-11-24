import type { RealtimeTalkStatus } from "./shared.ts";

type Cue = "wake" | "bye";
const assets = {
  wake: new URL("./chime_wake.flac", import.meta.url).href,
  bye: new URL("./chime_bye.flac", import.meta.url).href,
};

let context: AudioContext | undefined;
let buffers: Record<Cue, Promise<AudioBuffer>> | undefined;
let playing: AudioBufferSourceNode | undefined;
let playbackGeneration = 0;

// Call synchronously from the Talk button gesture, before starting the transport.
export function prepareTalkChimes(): void {
  cancelTalkChime();
  try {
    const audio = (context ??= new AudioContext());
    void audio.resume().catch(() => undefined);
    const load = async (cue: Cue) => {
      const response = await fetch(assets[cue]);
      if (!response.ok) {
        throw new Error("Talk chime unavailable");
      }
      return audio.decodeAudioData(await response.arrayBuffer());
    };
    buffers ??= { wake: load("wake"), bye: load("bye") };
    void Promise.all(Object.values(buffers)).catch(() => undefined);
  } catch {
    // Audio is optional: unsupported playback must not affect Talk.
  }
}

function cancelTalkChime(): void {
  playbackGeneration += 1;
  const source = playing;
  playing = undefined;
  source?.stop();
}

async function playTalkChime(cue: Cue): Promise<void> {
  cancelTalkChime();
  const generation = playbackGeneration;
  try {
    const buffer = await buffers?.[cue];
    if (!buffer || context?.state !== "running" || generation !== playbackGeneration) {
      return;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        if (playing === source) {
          playing = undefined;
        }
      },
      { once: true },
    );
    source.start();
    playing = source;
  } catch {
    // Fail silently instead of disrupting the call.
  }
}

export class TalkChimes {
  private phase: "starting" | "ready" | "ended" = "starting";

  constructor(
    private readonly replacement: boolean,
    private readonly play: (cue: Cue) => void = (cue) => void playTalkChime(cue),
    private readonly cancel = cancelTalkChime,
  ) {}

  status(status: RealtimeTalkStatus, echoCancellation: boolean): void {
    if (status === "listening" && this.phase === "starting") {
      this.phase = "ready";
      if (!this.replacement && echoCancellation) {
        this.play("wake");
      }
    } else if (status === "error") {
      this.end(false);
    } else if (status === "idle") {
      this.end(true);
    }
  }

  end(clean: boolean): void {
    if (this.phase === "ended") {
      return;
    }
    const ready = this.phase === "ready";
    this.phase = "ended";
    if (clean && ready) {
      this.play("bye");
    } else {
      this.cancel();
    }
  }
}
