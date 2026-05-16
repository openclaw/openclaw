import { beforeEach, describe, expect, it } from "vitest";
import {
  getRecentDiagnosticPhases,
  recordDiagnosticPhase,
  resetDiagnosticPhasesForTest,
} from "./diagnostic-phase.js";

function recordPhase(name: string): void {
  recordDiagnosticPhase({
    name,
    startedAt: 100,
    endedAt: 110,
    durationMs: 10,
  });
}

beforeEach(() => {
  resetDiagnosticPhasesForTest();
});

describe("diagnostic phase snapshots", () => {
  it("returns an empty list for non-positive and non-finite limits", () => {
    recordPhase("first");
    recordPhase("second");

    expect(getRecentDiagnosticPhases(0)).toStrictEqual([]);
    expect(getRecentDiagnosticPhases(-1)).toStrictEqual([]);
    expect(getRecentDiagnosticPhases(Number.NaN)).toStrictEqual([]);
    expect(getRecentDiagnosticPhases(Number.POSITIVE_INFINITY)).toStrictEqual([]);
  });

  it("returns copies of the most recent phases for positive limits", () => {
    recordPhase("first");
    recordPhase("second");
    recordPhase("third");

    const phases = getRecentDiagnosticPhases(2);

    expect(phases.map((phase) => phase.name)).toStrictEqual(["second", "third"]);
    phases[0]!.name = "mutated";
    expect(getRecentDiagnosticPhases(2).map((phase) => phase.name)).toStrictEqual([
      "second",
      "third",
    ]);
  });
});