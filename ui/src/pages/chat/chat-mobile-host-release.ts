import { projectDistance } from "../../lib/motion/gesture.ts";

/** Release speed (px/s) that turns a drag into a flick toward the next detent. */
const FLICK_VELOCITY = 400;
/** A hard throw skips intermediate detents. */
const THROW_VELOCITY = 2000;
/** A slow release this close to the dock detent settles onto it. */
const DOCK_MAGNET = 24;

export type MobileSheetDrag = {
  /** Finger-following height, below `minimum` while the sheet is pulled down. */
  height: number;
  /** Height when the drag started; the natural detent of an independent sheet. */
  start: number;
  minimum: number;
  maximum: number;
  dock: number;
  /** The large detent the expand control uses; flicks stop here before full height. */
  expanded: number;
  /** Independent sheets float above the conversation and have no dock detent. */
  independent: boolean;
};

export type MobileSheetRelease =
  | { kind: "close" }
  | { kind: "rest"; height: number; mode: "dock" | "expanded" };

/**
 * Chooses where a released sheet comes to rest. Flicks step to the next detent in their
 * direction (close, dock or natural height, expanded, full height), as iOS sheets do; slow releases
 * keep the exact height people chose, and a sheet pulled below its minimum closes once
 * its projected momentum carries it past half of that minimum.
 */
export function resolveMobileSheetRelease(
  drag: MobileSheetDrag,
  velocity: number,
): MobileSheetRelease {
  const rest = (height: number): MobileSheetRelease => ({
    kind: "rest",
    height,
    mode: height > drag.dock ? "expanded" : "dock",
  });
  if (Math.abs(velocity) >= FLICK_VELOCITY) {
    const detents = [0, drag.independent ? drag.start : drag.dock, drag.expanded, drag.maximum];
    const ahead = detents
      .filter((detent) => (velocity > 0 ? detent > drag.height + 1 : detent < drag.height - 1))
      .toSorted((left, right) => Math.abs(left - drag.height) - Math.abs(right - drag.height));
    const target = Math.abs(velocity) >= THROW_VELOCITY ? ahead.at(-1) : ahead[0];
    if (target !== undefined) {
      return target === 0 ? { kind: "close" } : rest(target);
    }
  }
  if (drag.height < drag.minimum) {
    const projected = drag.height + projectDistance(velocity);
    return projected < drag.minimum / 2 ? { kind: "close" } : rest(drag.minimum);
  }
  if (!drag.independent && Math.abs(drag.height - drag.dock) <= DOCK_MAGNET) {
    return rest(drag.dock);
  }
  return rest(Math.min(drag.maximum, drag.height));
}
