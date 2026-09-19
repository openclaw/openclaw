import { describe, expect, it } from "vitest";
import { runCompactionCurationCalibration } from "../../scripts/bench-compaction-curation.js";
import { COMPACTION_CURATION_CALIBRATION_CASES } from "../../scripts/fixtures/compaction-curation-corpus.js";

describe("compaction curation calibration corpus", () => {
  it("matches the expected retention policy across the representative corpus", async () => {
    const report = await runCompactionCurationCalibration({
      samples: 1,
      judgmentDelayMs: 0,
    });

    expect(report.corpusCases).toBe(COMPACTION_CURATION_CALIBRATION_CASES.length);
    expect(report.passedCases).toBe(report.corpusCases);
  });

  it("keeps oversized tail evidence and unresolved failure evidence", async () => {
    const report = await runCompactionCurationCalibration({
      samples: 1,
      judgmentDelayMs: 0,
      caseIds: ["oversized-tail-fact", "hidden-failure-in-success-result"],
    });

    expect(report.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "oversized-tail-fact",
          passed: true,
          actual: expect.objectContaining({ considered: 0, omitted: 0 }),
        }),
        expect.objectContaining({
          id: "hidden-failure-in-success-result",
          passed: true,
          actual: expect.objectContaining({ considered: 1, omitted: 0 }),
        }),
      ]),
    );
  });

  it("reports positive estimated token savings only for expected omission cases", async () => {
    const report = await runCompactionCurationCalibration({
      samples: 1,
      judgmentDelayMs: 0,
    });

    for (const entry of report.cases) {
      if (entry.expected.omitted > 0) {
        expect(entry.input.tokenSavings).toBeGreaterThan(0);
      } else {
        expect(entry.input.tokenSavings).toBe(0);
      }
    }
  });
});
