let context: AudioContext | undefined;

// Resume synchronously during the Talk button gesture. Keep cue assets off the boot path.
export function prepareTalkChimes(): void {
  try {
    const audio = (context ??= new AudioContext());
    void audio.resume().catch(() => undefined);
    void import("./chimes.ts")
      .then(({ loadTalkChimes }) => loadTalkChimes(audio))
      .catch(() => undefined);
  } catch {
    // Audio is optional: unsupported playback must not affect Talk.
  }
}
