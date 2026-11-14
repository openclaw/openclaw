import { onSettled } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import type { CommandPaletteMode } from "./command-palette-contract.ts";

/** The dock rides the panel's new height when the mode changes, as one motion. */
export function createModeGlide(mode: () => CommandPaletteMode, stack: () => HTMLElement) {
  let height: number | undefined;
  let shownMode: CommandPaletteMode | undefined;
  let animation: Animation | undefined;
  onSettled(() => () => animation?.cancel());
  createLayoutMeasurement(
    mode,
    (next) => {
      const element = stack();
      const switched = shownMode !== undefined && next !== shownMode;
      const moving = animation?.playState === "running" || animation?.playState === "paused";
      // ResizeObserver also sees animation frames, not just natural layout changes.
      if (!switched && moving) {
        return;
      }
      const from = moving ? element.getBoundingClientRect().height : height;
      // Measure the new mode without the previous animation overriding its height.
      animation?.cancel();
      animation = undefined;
      height = element.getBoundingClientRect().height;
      shownMode = next;
      if (
        switched &&
        from !== undefined &&
        Math.abs(from - height) > 1 &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        animation = element.animate([{ height: `${from}px` }, { height: `${height}px` }], {
          duration: 180,
          easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        });
      }
    },
    { targets: () => [stack()], changeTiming: "sync" },
  );
}
