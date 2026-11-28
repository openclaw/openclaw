import type { createMicrophoneMeterRenderer } from "./microphone-meter-renderer.ts";

export type { MicrophoneMeterStatus } from "./microphone-meter-renderer.ts";

type Meter = ReturnType<typeof createMicrophoneMeterRenderer>;

/** The CSS indicator and Stop are already live; painting does not gate either one. */
export function createMicrophoneMeter(
  ...args: Parameters<typeof createMicrophoneMeterRenderer>
): Meter {
  let renderer: Meter | undefined;
  let retired = false;
  let peak = 0;
  let latest = 0;
  async function startPainting() {
    const { createMicrophoneMeterRenderer } = await import("./microphone-meter-renderer.ts");
    if (retired) {
      return;
    }
    renderer = createMicrophoneMeterRenderer(...args);
    // A short syllable can end before the first canvas frame is ready.
    renderer.setLevel(peak);
    if (latest !== peak) {
      renderer.setLevel(latest);
    }
  }
  void startPainting().catch(() => {
    // Unavailable decorative code leaves the CSS indicator in place.
  });
  return {
    setLevel(level) {
      if (renderer) {
        renderer.setLevel(level);
      } else {
        peak = Math.max(peak, level);
        latest = level;
      }
    },
    dispose() {
      retired = true;
      renderer?.dispose();
    },
  };
}
