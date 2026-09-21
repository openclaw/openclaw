import { describe, expect, it } from "vitest";
import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";

function observation(
  overrides: Partial<{
    replicaId: string;
    candidateEntropy: number;
    coherence: number;
    mobility: number;
    evidenceCompleteness: number;
    verifierDisagreement: number;
    resourcePressure: number;
    contextPressure: number;
    debtPressure: number;
    branchingRatio: number;
    progressRate: number;
  }> = {},
) {
  return {
    replicaId: "r1",
    candidateEntropy: 0.5,
    coherence: 0.5,
    mobility: 0.5,
    evidenceCompleteness: 0.5,
    verifierDisagreement: 0.1,
    resourcePressure: 0.1,
    contextPressure: 0.1,
    debtPressure: 0.1,
    branchingRatio: 0.5,
    progressRate: 0.5,
    ...overrides,
  };
}

describe("mixed-phase population controller", () => {
  it("drains before expanding when pressure is jammed", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [observation({ resourcePressure: 0.95 })],
    });
    expect(assessPopulation(snapshot).actions).toEqual([
      {
        kind: "drain",
        reason: "resource/context/debt pressure is too high for further expansion",
      },
    ]);
  });

  it("requests measurement for critical disagreement", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [observation({ verifierDisagreement: 0.9 })],
    });
    expect(assessPopulation(snapshot).actions[0]).toMatchObject({
      kind: "measure",
      targetReplicaIds: ["r1"],
    });
  });

  it("uses a bounded glass-breaker rather than unbounded respawn", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation({ mobility: 0.05, progressRate: 0.05, evidenceCompleteness: 0.2 }),
      ],
    });
    expect(assessPopulation(snapshot).actions).toContainEqual({
      kind: "perturb",
      profile: "glass-breaker",
      count: 1,
      reason: "bounded fresh-context perturbation for stalled low-mobility search",
    });
  });

  it("freezes a well-evidenced low-entropy candidate without granting authority", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation({
          candidateEntropy: 0.05,
          coherence: 0.95,
          evidenceCompleteness: 0.95,
          mobility: 0.1,
          progressRate: 0.4,
        }),
      ],
    });
    const decision = assessPopulation(snapshot);
    expect(decision.authority).toBe("search-only");
    expect(decision.actions).toContainEqual({
      kind: "freeze",
      targetReplicaIds: ["r1"],
      reason: "low-entropy candidates with substantial evidence should be frozen for verification",
    });
  });
});
