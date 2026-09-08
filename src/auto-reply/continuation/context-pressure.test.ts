import { describe, expect, it } from "vitest";
import { type PressureBand, resolveContextPressureBand } from "./context-pressure.js";

describe("resolveContextPressureBand", () => {
  it("returns 0 below all bands", () => {
    expect(resolveContextPressureBand(0.1, 0.25)).toBe(0);
    expect(resolveContextPressureBand(0.24, 0.25)).toBe(0);
  });

  it("returns configured first-threshold and escalation bands", () => {
    expect(resolveContextPressureBand(0.25, 0.25)).toBe(25);
    expect(resolveContextPressureBand(0.8, 0.8)).toBe(80);
    expect(resolveContextPressureBand(0.9, 0.8)).toBe(90);
    expect(resolveContextPressureBand(0.95, 0.8)).toBe(95);
  });

  it("return type is the pressure band type", () => {
    const band: PressureBand = resolveContextPressureBand(0.5, 0.25);
    expect(band).toBe(25);
  });

  it("returns highest crossed band", () => {
    expect(resolveContextPressureBand(0.92, 0.8)).toBe(90);
    expect(resolveContextPressureBand(0.99, 0.8)).toBe(95);
  });

  it("resolves the configured early-warning band below threshold", () => {
    expect(resolveContextPressureBand(0.1, 0.8, 0.3125)).toBe(0);
    expect(resolveContextPressureBand(0.25, 0.8, 0.3125)).toBe(25);
    expect(resolveContextPressureBand(0.25, 0.8, 0)).toBe(0);
  });
});
