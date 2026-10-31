/**
 * Gesture physics for draggable sheets, after WWDC18 "Designing Fluid Interfaces":
 * project a release's momentum with the scroll-view deceleration rate, and resist
 * dragging past a boundary instead of stopping dead.
 */

/** `UIScrollView.DecelerationRate.normal`: matches the momentum people already know. */
const DECELERATION_RATE = 0.998;
/** UIKit's rubber-band constant as commonly reverse-engineered from UIScrollView. */
const RUBBER_BAND_COEFFICIENT = 0.55;
/** Samples older than this no longer describe the finger's current motion. */
const VELOCITY_WINDOW_MS = 100;

/** Distance travelled after decelerating to rest at the scroll-view rate (px, px/s in). */
export function projectDistance(velocity: number): number {
  return ((velocity / 1000) * DECELERATION_RATE) / (1 - DECELERATION_RATE);
}

/** Visible movement for `overflow` px dragged beyond a boundary: always less, never stops. */
export function rubberBand(overflow: number, dimension: number): number {
  if (overflow <= 0 || dimension <= 0) {
    return 0;
  }
  return (1 - 1 / ((overflow * RUBBER_BAND_COEFFICIENT) / dimension + 1)) * dimension;
}

/** Tracks recent pointer positions and reports release velocity in px/s. */
export function createVelocityTracker() {
  let samples: { time: number; position: number }[] = [];
  return {
    add(time: number, position: number) {
      samples.push({ time, position });
      samples = samples.filter((sample) => time - sample.time <= VELOCITY_WINDOW_MS);
    },
    /** A finger that paused before lifting reports no momentum. */
    velocity(now: number): number {
      const recent = samples.filter((sample) => now - sample.time <= VELOCITY_WINDOW_MS);
      const first = recent[0];
      const last = recent.at(-1);
      if (!first || !last || last.time - first.time < 8) {
        return 0;
      }
      return ((last.position - first.position) / (last.time - first.time)) * 1000;
    },
  };
}
