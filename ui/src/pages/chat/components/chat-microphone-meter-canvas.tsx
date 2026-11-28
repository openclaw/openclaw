import { onSettled } from "solid-js";
import { createMediaQuerySource } from "../../../lib/reactive/platform.ts";
import type { RealtimeTalkLevelSignal } from "../talk/level.ts";
import { createMicrophoneMeter, type MicrophoneMeterStatus } from "../talk/microphone-meter.ts";

export function MicrophoneMeterCanvas(props: {
  host: () => HTMLElement | undefined;
  source: RealtimeTalkLevelSignal | undefined;
  status: Exclude<MicrophoneMeterStatus, "connecting">;
}) {
  const initialSource = () => props.source;
  const initialStatus = () => props.status;
  const reducedMotion = createMediaQuerySource("(prefers-reduced-motion: reduce)");
  let canvas: HTMLCanvasElement | undefined;
  onSettled(() => {
    const currentHost = props.host();
    const surface = canvas;
    if (!currentHost || !surface) {
      return undefined;
    }
    let renderer: ReturnType<typeof createMicrophoneMeter> | undefined;
    const source = initialSource();
    const status = initialStatus();
    const initialLevel = source?.value ?? 0;
    const setLevel = (level: number) => {
      const value = String(level);
      if (currentHost.dataset.level !== value) {
        currentHost.dataset.level = value;
      }
      // CSS already draws silence. Allocate only when there is activity to paint.
      if (!renderer && (status === "thinking" || (status === "listening" && level > 0))) {
        renderer = createMicrophoneMeter(currentHost, surface, status, reducedMotion);
        // Preserve the first transition from silence rather than jumping to its target.
        renderer.setLevel(initialLevel);
      }
      renderer?.setLevel(level);
    };
    // The owner's subscription immediately supplies its current level.
    const stop = source?.subscribe(setLevel);
    if (!source) {
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
