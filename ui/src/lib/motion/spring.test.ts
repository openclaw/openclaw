// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SHEET_SPRING,
  springCoefficients,
  springEasing,
  springSettleTime,
  springValue,
} from "./spring.ts";

describe("spring", () => {
  it("matches Apple's documented duration/bounce conversion", () => {
    // SwiftUI Spring docs: Spring(duration: 0.5, bounce: 0.3) → stiffness 157.9, damping 17.6.
    const { stiffness, damping } = springCoefficients({ duration: 0.5, bounce: 0.3 });
    expect(stiffness).toBeCloseTo(157.9, 1);
    expect(damping).toBeCloseTo(17.6, 1);
  });

  it("starts at rest, never overshoots without bounce, and settles on the target", () => {
    expect(springValue(SHEET_SPRING, 0)).toBe(0);
    let previous = 0;
    for (let ms = 1; ms <= 1000; ms += 1) {
      const value = springValue(SHEET_SPRING, ms / 1000);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
    expect(springValue(SHEET_SPRING, springSettleTime(SHEET_SPRING))).toBeGreaterThan(0.999);
  });

  it("carries a release velocity into the first frames", () => {
    const step = 1e-4;
    expect(springValue(SHEET_SPRING, step, 4) / step).toBeCloseTo(4, 0);
    expect(springValue(SHEET_SPRING, step, -2) / step).toBeCloseTo(-2, 0);
    // A velocity toward the target arrives sooner than a resting start.
    expect(springValue(SHEET_SPRING, 0.1, 4)).toBeGreaterThan(springValue(SHEET_SPRING, 0.1));
  });

  it("bounces only when asked to and overdamps below zero", () => {
    const peak = (bounce: number) => {
      let max = 0;
      for (let ms = 0; ms <= 1500; ms += 1) {
        max = Math.max(max, springValue({ duration: 0.5, bounce }, ms / 1000));
      }
      return max;
    };
    // Damping ratio 0.7 overshoots by e^(−πζ/√(1−ζ²)) ≈ 4.6%.
    expect(peak(0.3)).toBeCloseTo(1.046, 3);
    expect(peak(0)).toBeLessThanOrEqual(1);
    expect(peak(-0.5)).toBeLessThanOrEqual(1);
    expect(springValue({ duration: 0.5, bounce: -0.5 }, 0.2)).toBeLessThan(
      springValue(SHEET_SPRING, 0.2),
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
    let squared = 0;
    let count = 0;
    for (let ms = 0; ms <= 600; ms += 5) {
      squared += (springValue(SHEET_SPRING, ms / 1000) - ios(ms / 1000)) ** 2;
      count += 1;
    }
    // 0.3 s fits within ~1.5% RMS of the distance over the first 600 ms.
    expect(Math.sqrt(squared / count)).toBeLessThan(0.02);
  });

  it("emits a monotonic linear() curve from 0 to 1 sampled once per frame", () => {
    const { easing, durationMs } = springEasing(SHEET_SPRING);
    const stops = easing.slice("linear(".length, -1).split(", ").map(Number);
    expect(stops[0]).toBe(0);
    expect(stops.at(-1)).toBe(1);
    expect(stops.length).toBe(Math.ceil(durationMs / (1000 / 60)) + 1);
    expect(stops.every((stop, index) => index === 0 || stop >= stops[index - 1]!)).toBe(true);
  });

  it("keeps the CSS motion tokens generated from the solver", () => {
    // The formatter wraps long linear() lists; compare without whitespace.
    const css = readFileSync(new URL("../../styles/base.css", import.meta.url), "utf8").replace(
      /\s+/g,
      "",
    );
    const { easing, durationMs } = springEasing(SHEET_SPRING);
    expect(css).toContain(`--motion-spring-sheet:${easing.replace(/\s+/g, "")};`);
    expect(css).toContain(`--motion-spring-sheet-duration:${durationMs}ms;`);
  });
});
