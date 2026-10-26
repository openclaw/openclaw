import { onSettled } from "solid-js";
import { createMediaQuerySource } from "../../../lib/reactive/platform.ts";
import type { RealtimeTalkLevelSignal } from "./level.ts";
import { createMicrophoneMeter, type MicrophoneMeterStatus } from "./microphone-meter.ts";

type MicrophoneMeterCanvasProps = {
  initialStatus: MicrophoneMeterStatus;
  initialSource?: RealtimeTalkLevelSignal;
  readHost: () => HTMLElement | undefined;
  readBars: () => readonly HTMLElement[];
};

/** Keyed by status/source; native level events do not rerender this canvas. */
export function MicrophoneMeterCanvas(props: MicrophoneMeterCanvasProps) {
  const initialStatus = props.initialStatus;
  if (initialStatus === "connecting") {
    return null;
  }
  const initialSource = props.initialSource;
  const reducedMotion = createMediaQuerySource("(prefers-reduced-motion: reduce)");
  let canvas: HTMLCanvasElement | undefined;
  onSettled(() => {
    const host = props.readHost();
    const surface = canvas;
    if (!host || !surface) {
      return undefined;
    }
    let renderer: ReturnType<typeof createMicrophoneMeter> | undefined;
    const initialLevel = initialSource?.value ?? 0;
    const setLevel = (level: number) => {
      const value = String(level);
      if (host.dataset.level !== value) {
        host.dataset.level = value;
      }
      // CSS already draws silence. Allocate only when there is activity to paint.
      if (
        !renderer &&
        (initialStatus === "thinking" || (initialStatus === "listening" && level > 0))
      ) {
        renderer = createMicrophoneMeter(
          host,
          surface,
          props.readBars(),
          initialStatus,
          reducedMotion,
        );
        // Preserve the first transition from silence rather than jumping to its target.
        renderer.setLevel(initialLevel);
      }
      renderer?.setLevel(level);
    };
    // The owner's subscription immediately supplies its current level.
    const stop = initialSource?.subscribe(setLevel);
    if (!initialSource) {
      setLevel(0);
    }
    return () => {
      stop?.();
      renderer?.dispose();
    };
  });
  return (
    <canvas
      ref={(element) => (canvas = element)}
      class="agent-chat__voice-activity-canvas"
      aria-hidden="true"
    />
  );
}
