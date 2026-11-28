// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHEET_SPRING, springEasing, type Spring } from "./spring.ts";

function sampledSpring(spring: Spring, velocity = 0) {
  const { easing, durationMs } = springEasing(spring, velocity);
  const stops = easing
    .slice("linear(".length, -1)
    .split(", ")
    .map((stop, index, all) => {
      const [value, position] = stop.split(" ");
      const at =
        index === 0 ? 0 : index === all.length - 1 ? 1 : Number.parseFloat(position!) / 100;
      return { value: Number(value), at };
    });
  const value = (seconds: number) => {
    const at = Math.min(1, (seconds * 1000) / durationMs);
    const next = stops.findIndex((stop) => stop.at >= at);
    const end = stops[next]!;
    const start = stops[Math.max(0, next - 1)]!;
    return end.at === start.at
      ? end.value
      : start.value + ((end.value - start.value) * (at - start.at)) / (end.at - start.at);
  };
  return { durationMs, stops, value };
}

describe("spring", () => {
  it.each([
    [SHEET_SPRING, 0, 438.64908449, 41.88790205],
    [SHEET_SPRING, 4, 438.64908449, 41.88790205],
    [SHEET_SPRING, -2, 438.64908449, 41.88790205],
    [SHEET_SPRING, 12, 438.64908449, 41.88790205],
    [{ duration: 0.5, bounce: 0.3 }, 0, 157.91367042, 17.59291886],
    [{ duration: 0.5, bounce: -0.5 }, 0, 157.91367042, 50.26548246],
  ] as const)(
    "emits the reference motion for %j at velocity %s",
    (spring, velocity, stiffness, damping) => {
      const curve = sampledSpring(spring, velocity);
      expect(curve.stops[0]).toEqual({ value: 0, at: 0 });
      expect(curve.stops.at(-1)).toEqual({ value: 1, at: 1 });
      // Independently integrate the unit-mass equation using documented coefficients,
      // rather than comparing the emitted curve against the solver that generated it.
      let displacement = -1;
      let speed = velocity;
      for (let ms = 1; ms <= curve.durationMs; ms += 1) {
        for (let step = 0; step < 100; step += 1) {
          speed += (-damping * speed - stiffness * displacement) * 0.00001;
          displacement += speed * 0.00001;
        }
        const exact = ms === curve.durationMs ? 1 : 1 + displacement;
        expect(Math.abs(curve.value(ms / 1000) - exact)).toBeLessThan(0.006);
      }
    },
  );

  it("starts at rest, never overshoots without bounce, and settles on the target", () => {
    const curve = sampledSpring(SHEET_SPRING);
    expect(curve.value(0)).toBe(0);
    let previous = 0;
    for (let ms = 1; ms <= 1000; ms += 1) {
      const value = curve.value(ms / 1000);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
    expect(curve.value(curve.durationMs / 1000)).toBe(1);
  });

  it("carries a release velocity into the first frames", () => {
    const forward = sampledSpring(SHEET_SPRING, 4);
    const reverse = sampledSpring(SHEET_SPRING, -2);
    expect(Math.abs(forward.value(0.016) - 0.0908253)).toBeLessThan(0.006);
    expect(reverse.value(0.001)).toBeLessThan(0);
    expect(Math.abs(reverse.value(0.016) - 0.02215994)).toBeLessThan(0.006);
    expect(forward.value(0.1)).toBeGreaterThan(sampledSpring(SHEET_SPRING).value(0.1));
  });

  it("bounces only when asked to and overdamps below zero", () => {
    const peak = (bounce: number) => {
      const curve = sampledSpring({ duration: 0.5, bounce });
      let max = 0;
      for (let ms = 0; ms <= 1500; ms += 1) {
        max = Math.max(max, curve.value(ms / 1000));
      }
      return max;
    };
    expect(peak(0.3)).toBeCloseTo(1.046, 3);
    expect(peak(0)).toBeLessThanOrEqual(1);
    expect(peak(-0.5)).toBeLessThanOrEqual(1);
    expect(sampledSpring({ duration: 0.5, bounce: -0.5 }).value(0.2)).toBeLessThan(
      sampledSpring(SHEET_SPRING).value(0.2),
    );
  });

  it("tracks the iOS sheet presentation curve that Ionic and Vaul reproduce", () => {
    const sample = (a: number, b: number, t: number) =>
      3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
    const ios = (time: number) => {
      if (time >= 0.5) {
        return 1;
      }
      let low = 0;
      let high = 1;
      for (let step = 0; step < 40; step += 1) {
        const middle = (low + high) / 2;
        if (sample(0.32, 0, middle) < time / 0.5) {
          low = middle;
        } else {
          high = middle;
        }
      }
      return sample(0.72, 1, (low + high) / 2);
    };
    const curve = sampledSpring(SHEET_SPRING);
    let squared = 0;
    let count = 0;
    for (let ms = 0; ms <= 600; ms += 5) {
      squared += (curve.value(ms / 1000) - ios(ms / 1000)) ** 2;
      count += 1;
    }
    expect(Math.sqrt(squared / count)).toBeLessThan(0.02);
  });

  it("emits a compact monotonic linear() curve", () => {
    for (const velocity of [0, 4, 12]) {
      const { stops } = sampledSpring(SHEET_SPRING, velocity);
      expect(stops[0]).toEqual({ value: 0, at: 0 });
      expect(stops.at(-1)).toEqual({ value: 1, at: 1 });
      expect(stops.length).toBeLessThan(20);
      expect(
        stops.every((stop, index) => index === 0 || stop.value >= stops[index - 1]!.value),
      ).toBe(true);
    }
  });

  it("keeps the CSS motion tokens generated from the solver", () => {
    const css = readFileSync(new URL("../../styles/base.css", import.meta.url), "utf8").replace(
      /\s+/g,
      "",
    );
    const { easing, durationMs } = springEasing(SHEET_SPRING);
    expect(css).toContain(`--motion-sheet-duration:${durationMs}ms;`);
    expect(css).toContain(`--motion-sheet:${durationMs}ms${easing.replace(/\s+/g, "")};`);
  });
});
