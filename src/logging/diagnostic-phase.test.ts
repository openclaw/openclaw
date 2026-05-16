import { afterEach, describe, expect, it } from "vitest";
import {
  endDiagnosticPhase,
  getRecentDiagnosticPhases,
  startDiagnosticPhase,
} from "./diagnostic-phase.js";

function flushPhases(): void {
  // Drain any in-flight phases left by other tests; getRecentDiagnosticPhases
  // pulls from a module-level buffer that we cannot directly reset.
  for (let i = 0; i < 256; i += 1) {
    endDiagnosticPhase();
  }
}

function seedPhases(count: number): void {
  for (let i = 0; i < count; i += 1) {
    startDiagnosticPhase(`phase-${i}`);
    endDiagnosticPhase();
  }
}

describe("getRecentDiagnosticPhases limit guard (#82646)", () => {
  afterEach(() => {
    flushPhases();
  });

  it("returns an empty array for an explicit zero limit", () => {
    seedPhases(3);
    expect(getRecentDiagnosticPhases(0)).toEqual([]);
  });

  it("returns an empty array for a negative limit", () => {
    seedPhases(3);
    expect(getRecentDiagnosticPhases(-2)).toEqual([]);
  });

  it("returns an empty array for a non-finite limit", () => {
    seedPhases(3);
    expect(getRecentDiagnosticPhases(Number.NaN)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("returns the requested suffix when the limit is positive", () => {
    seedPhases(3);
    const last = getRecentDiagnosticPhases(2);
    expect(last).toHaveLength(2);
  });
});
