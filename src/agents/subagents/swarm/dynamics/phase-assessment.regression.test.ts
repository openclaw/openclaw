import { describe, expect, it } from "vitest";
import { assessLocalPhase, phaseMixture } from "./phase-assessment.js";
import type { LocalDynamicsObservation } from "./population-types.js";

const stalled: LocalDynamicsObservation = {
  replicaId: "stalled-review",
  candidateEntropy: 0.1,
  coherence: 0.5,
  mobility: 0.05,
  evidenceCompleteness: 0.2,
  verifierDisagreement: 0.9,
  resourcePressure: 0.1,
  contextPressure: 0.1,
  debtPressure: 0.1,
  branchingRatio: 0.5,
  progressRate: 0.05,
};

describe("local phase regressions", () => {
  it("preserves high disagreement instead of calling a stalled review glass", () => {
    expect(assessLocalPhase(stalled).phase).toBe("critical");
    expect(assessLocalPhase({ ...stalled, verifierDisagreement: 0 }).phase).toBe("glass");
    expect(assessLocalPhase({ ...stalled, resourcePressure: 0.95 }).phase).toBe("jammed");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.1])(
    "rejects malformed normalized telemetry %s",
    (value) => {
      expect(() => assessLocalPhase({ ...stalled, verifierDisagreement: value })).toThrow();
    },
  );

  it("cannot double-count a replica in the phase mixture", () => {
    const assessment = assessLocalPhase(stalled);
    expect(() => phaseMixture([assessment, assessment])).toThrow(
      "one valid assessment per replica",
    );
  });
});
