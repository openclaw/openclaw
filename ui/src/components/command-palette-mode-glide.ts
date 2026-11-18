import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import type { CommandPaletteMode } from "./command-palette-contract.ts";

/** The dock rides the panel's new height when the mode changes, as one motion. */
export function createModeGlide(mode: () => CommandPaletteMode, stack: () => HTMLElement) {
  let height: number | undefined;
  let shownMode: CommandPaletteMode | undefined;
  createLayoutMeasurement(
    mode,
    (next) => {
      const element = stack();
      const from = height;
      height = element.getBoundingClientRect().height;
      const switched = shownMode !== undefined && next !== shownMode;
      shownMode = next;
      if (
        switched &&
        from !== undefined &&
        Math.abs(from - height) > 1 &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        element.animate([{ height: `${from}px` }, { height: `${height}px` }], {
          duration: 180,
          easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
        });
      }
    },
    { targets: () => [stack()], changeTiming: "sync" },
  );
}
