import { describe, expect, it } from "vitest";
import { createVelocityTracker, projectDistance, rubberBand } from "./gesture.ts";

describe("gesture physics", () => {
  it("projects momentum with the scroll-view deceleration rate", () => {
    // WWDC18: (v / 1000) · rate / (1 − rate) with rate 0.998 → ≈ 0.5 s of travel.
    expect(projectDistance(1000)).toBeCloseTo(499, 0);
    expect(projectDistance(-400)).toBeCloseTo(-199.6, 1);
    expect(projectDistance(0)).toBe(0);
  });

  it("resists overscroll progressively without ever reaching the dimension", () => {
    expect(rubberBand(0, 800)).toBe(0);
    expect(rubberBand(-20, 800)).toBe(0);
    const small = rubberBand(20, 800);
    const large = rubberBand(400, 800);
    expect(small).toBeLessThan(20);
    expect(small).toBeGreaterThan(10);
    expect(large / 400).toBeLessThan(small / 20);
    expect(rubberBand(100_000, 800)).toBeLessThan(800);
  });

  it("reports recent velocity and drops momentum after the finger pauses", () => {
    const tracker = createVelocityTracker();
    for (let time = 0; time <= 80; time += 16) {
      tracker.add(time, time * 2);
    }
    expect(tracker.velocity(80)).toBeCloseTo(2000, 0);
    expect(tracker.velocity(400)).toBe(0);
    const single = createVelocityTracker();
    single.add(0, 10);
    expect(single.velocity(0)).toBe(0);
  });
});
