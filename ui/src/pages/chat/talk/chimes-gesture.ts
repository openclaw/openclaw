let context: AudioContext | undefined;

// Resume synchronously during the Talk button gesture. Keep cue assets off the boot path.
export function prepareTalkChimes(): void {
  try {
    const audio = (context ??= new AudioContext());
    void audio.resume().catch(() => undefined);
    void loadChimes(audio);
  } catch {
    // Audio is optional: unsupported playback must not affect Talk.
  }
}

async function loadChimes(audio: AudioContext): Promise<void> {
  try {
    const { loadTalkChimes } = await import("./chimes.ts");
    loadTalkChimes(audio);
  } catch {
    // A cue chunk that fails to load must not affect Talk.
  }
}
