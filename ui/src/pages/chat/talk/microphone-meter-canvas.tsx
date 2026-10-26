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
  const initialSource = props.initialSource;
  const reducedMotion = createMediaQuerySource("(prefers-reduced-motion: reduce)");
  let canvas: HTMLCanvasElement | undefined;
  onSettled(() => {
    const host = props.readHost();
    if (!host || !canvas) {
      return undefined;
    }
    // Connecting is brief and uses the CSS bars without allocating a bitmap.
    const renderer =
      initialStatus === "connecting"
        ? undefined
        : createMicrophoneMeter(host, canvas, props.readBars(), initialStatus, reducedMotion);
    const setLevel = (level: number) => {
      const value = String(level);
      if (host.dataset.level !== value) {
        host.dataset.level = value;
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
