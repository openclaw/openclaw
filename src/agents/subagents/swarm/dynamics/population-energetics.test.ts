import { describe, expect, it } from "vitest";
import {
  assessAgentEnergetics,
  assessPopulationEnergetics,
  type AgentEnergeticObservation,
} from "./population-energetics.js";

function observation(
  replicaId: string,
  patch: Partial<AgentEnergeticObservation> = {},
): AgentEnergeticObservation {
  return {
    replicaId,
    energy: 0.5,
    temperature: 0.5,
    mobility: 0.5,
    noveltyRate: 0.5,
    evidenceCompleteness: 0.5,
    verifierDisagreement: 0.1,
    correlation: 0.4,
    susceptibility: 0.2,
    resourcePressure: 0.2,
    ...patch,
  };
}

describe("population energetics", () => {
  it("keeps energy and temperature orthogonal", () => {
    const explorer = assessAgentEnergetics(
      observation("explorer", {
        energy: 0.2,
        temperature: 0.9,
        mobility: 0.8,
        noveltyRate: 0.8,
        correlation: 0.1,
      }),
    );
    const verifier = assessAgentEnergetics(
      observation("verifier", {
        energy: 0.95,
        temperature: 0.05,
        mobility: 0.05,
        noveltyRate: 0.05,
        evidenceCompleteness: 0.95,
        verifierDisagreement: 0.05,
        correlation: 0.9,
      }),
    );

    expect(explorer).toMatchObject({ energyLevel: "low", regime: "gas" });
    expect(verifier).toMatchObject({ energyLevel: "high", regime: "crystal" });
  });

  it("reheats a high-energy glass instead of allocating still more energy", () => {
    const decision = assessPopulationEnergetics([
      observation("stuck", {
        energy: 0.9,
        temperature: 0.15,
        mobility: 0.05,
        noveltyRate: 0.05,
        evidenceCompleteness: 0.3,
        correlation: 0.95,
      }),
    ]);

    expect(decision.assessments[0]).toMatchObject({ regime: "glass", energyLevel: "high" });
    expect(decision.actions).toContainEqual(
      expect.objectContaining({ kind: "reheat", targetReplicaIds: ["stuck"] }),
    );
    expect(decision.actions.some((action) => action.kind === "deepen")).toBe(false);
  });

  it("moves informative disagreement into high-energy measurement", () => {
    const decision = assessPopulationEnergetics([
      observation("disagreement", {
        energy: 0.45,
        temperature: 0.5,
        verifierDisagreement: 0.85,
        susceptibility: 0.75,
      }),
    ]);

    expect(decision.assessments[0]).toMatchObject({ regime: "critical" });
    expect(decision.actions.map((action) => action.kind)).toEqual(["measure", "deepen"]);
  });

  it("preserves mixed local regimes instead of collapsing to one swarm mode", () => {
    const decision = assessPopulationEnergetics([
      observation("gas", {
        energy: 0.2,
        temperature: 0.9,
        mobility: 0.8,
        noveltyRate: 0.9,
        correlation: 0.1,
      }),
      observation("crystal", {
        energy: 0.9,
        temperature: 0.05,
        mobility: 0.05,
        evidenceCompleteness: 0.95,
        verifierDisagreement: 0.05,
        correlation: 0.9,
      }),
      observation("glass", {
        energy: 0.85,
        temperature: 0.15,
        mobility: 0.05,
        noveltyRate: 0.05,
        evidenceCompleteness: 0.3,
        correlation: 0.9,
      }),
      observation("jammed", {
        energy: 0.7,
        temperature: 0.4,
        resourcePressure: 0.95,
      }),
    ]);

    expect(decision.assessments.map((assessment) => assessment.regime)).toEqual([
      "gas",
      "crystal",
      "glass",
      "jammed",
    ]);
    expect(decision.actions.map((action) => action.kind)).toEqual(["drain", "reheat", "freeze"]);
    expect(decision.effectivePopulationSize).not.toBeNull();
    expect(decision.effectivePopulationSize).toBeLessThan(4);
    expect(decision.authority).toBe("search-only");
  });
});
