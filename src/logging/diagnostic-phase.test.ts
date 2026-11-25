// Diagnostic phase tests cover phase timing and diagnostic event emission.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getCurrentDiagnosticPhase,
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
} from "./diagnostic-phase.js";

describe("getRecentDiagnosticPhases", () => {
  it("returns the six most recent completed phases", async () => {
    resetDiagnosticPhasesForTest();
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      await withDiagnosticPhase(name, () => undefined);
    }

    expect(getRecentDiagnosticPhases(0).map((phase) => phase.name)).toEqual([
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });

  it("filters completed phases by attribution time without discarding retained history", async () => {
    resetDiagnosticPhasesForTest();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await withDiagnosticPhase("phase-a", () => undefined);

      expect(getRecentDiagnosticPhases(1_001)).toEqual([]);
      expect(getRecentDiagnosticPhases(1_000)).toEqual([
        expect.objectContaining({ name: "phase-a", endedAt: 1_000 }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not apply completed-phase recency filtering to active phases", async () => {
    resetDiagnosticPhasesForTest();
    const deferred = createDeferred();
    const phase = withDiagnosticPhase("legitimate.long-running-work", () => deferred.promise);

    try {
      expect(getRecentDiagnosticPhases(Date.now())).toEqual([]);
      expect(getCurrentDiagnosticPhase()).toBe("legitimate.long-running-work");
    } finally {
      deferred.resolve();
      await phase;
    }
  });
});
