// Diagnostic phase tests cover phase timing and diagnostic event emission.
import { describe, expect, it } from "vitest";
import {
  getActiveDiagnosticPhases,
  getRecentDiagnosticPhases,
  recordDiagnosticPhase,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
} from "./diagnostic-phase.js";

describe("getRecentDiagnosticPhases", () => {
  it("returns an empty list for zero, negative, and non-finite limits", () => {
    resetDiagnosticPhasesForTest();
    recordDiagnosticPhase({
      name: "phase-a",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });
    recordDiagnosticPhase({
      name: "phase-b",
      startedAt: 3,
      endedAt: 4,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });

    expect(getRecentDiagnosticPhases(0)).toEqual([]);
    expect(getRecentDiagnosticPhases(-1)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.NaN)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("returns the most recent phases for positive limits", () => {
    resetDiagnosticPhasesForTest();
    recordDiagnosticPhase({
      name: "phase-a",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });
    recordDiagnosticPhase({
      name: "phase-b",
      startedAt: 3,
      endedAt: 4,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });

    const recent = getRecentDiagnosticPhases(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.name).toBe("phase-b");
  });
});

describe("getActiveDiagnosticPhases", () => {
  it("returns an empty array when no phase has ever been active", () => {
    resetDiagnosticPhasesForTest();
    expect(getActiveDiagnosticPhases()).toEqual([]);
  });

  it("returns an empty array after all phases have exited (stale-stack edge)", async () => {
    // Belt-and-suspenders: a watchdog firing outside any phase must see
    // pending=[], not a leftover frame whose elapsedMs would otherwise be
    // computed against a stale `startedWallMs`. Sysdes follow-up
    // 2026-06-07: `getActiveDiagnosticPhases() outside any phase → []`.
    resetDiagnosticPhasesForTest();
    await withDiagnosticPhase("transient", async () => {
      // Inside the phase the stack is populated, by construction.
      expect(getActiveDiagnosticPhases().map((p) => p.name)).toEqual(["transient"]);
    });
    expect(getActiveDiagnosticPhases()).toEqual([]);
  });

  it("returns an empty array even when the phase finished with a thrown error", async () => {
    resetDiagnosticPhasesForTest();
    await expect(
      withDiagnosticPhase("throws", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getActiveDiagnosticPhases()).toEqual([]);
  });

  it("snapshots in-flight phases outermost → innermost with elapsed time", async () => {
    resetDiagnosticPhasesForTest();
    let captured: Array<{ name: string; elapsedMs: number }> = [];
    await withDiagnosticPhase("outer", async () => {
      await withDiagnosticPhase("inner", async () => {
        captured = getActiveDiagnosticPhases();
      });
    });
    expect(captured.map((p) => p.name)).toEqual(["outer", "inner"]);
    for (const phase of captured) {
      expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(phase.elapsedMs)).toBe(true);
    }
  });

  it("returns a deep copy that does not share references with the active stack", async () => {
    resetDiagnosticPhasesForTest();
    let firstSnapshot: Array<{ name: string; elapsedMs: number }> = [];
    let secondSnapshot: Array<{ name: string; elapsedMs: number }> = [];
    await withDiagnosticPhase("outer", async () => {
      firstSnapshot = getActiveDiagnosticPhases();
      // Mutate the snapshot — a deep copy must not affect future snapshots.
      firstSnapshot.push({ name: "injected", elapsedMs: 99 });
      if (firstSnapshot[0]) {
        firstSnapshot[0].name = "mutated";
      }
      secondSnapshot = getActiveDiagnosticPhases();
    });
    expect(secondSnapshot.map((p) => p.name)).toEqual(["outer"]);
  });
});
