import { describe, expect, it } from "vitest";
import { resolveDynamicsProfile } from "./dynamics-profiles.js";
import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";
import type { LocalDynamicsObservation, PopulationSnapshot } from "./population-types.js";

function observation(
  replicaId: string,
  overrides: Partial<LocalDynamicsObservation> = {},
): LocalDynamicsObservation {
  return {
    replicaId,
    candidateEntropy: 0.9,
    coherence: 0.2,
    mobility: 0.7,
    evidenceCompleteness: 0.1,
    verifierDisagreement: 0.1,
    resourcePressure: 0.1,
    contextPressure: 0.1,
    debtPressure: 0.1,
    branchingRatio: 0.5,
    progressRate: 0.5,
    ...overrides,
  };
}
function replica(replicaId: string): PopulationSnapshot["replicas"][number] {
  return {
    replicaId,
    campaignId: "c",
    groupId: "g",
    runId: replicaId,
    requesterSessionKey: "parent",
    profile: resolveDynamicsProfile("explorer"),
    authority: "search-only",
  };
}

describe("mixed-population regressions", () => {
  it("freezes a local candidate while unrelated hot replicas keep exploring", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation("hot"),
        observation("cold", {
          candidateEntropy: 0.05,
          coherence: 0.95,
          evidenceCompleteness: 0.95,
        }),
      ],
    });
    expect(assessPopulation(snapshot).actions).toContainEqual(
      expect.objectContaining({ kind: "freeze", targetReplicaIds: ["cold"] }),
    );
  });
  it("does not average away a minority saturated lane", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [
        observation("jam", { resourcePressure: 0.95 }),
        ...Array.from({ length: 9 }, (_, index) => observation(`hot-${index}`)),
      ],
    });
    expect(assessPopulation(snapshot).actions[0]?.kind).toBe("drain");
  });
  it("keeps missing observations unknown", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [replica("a"), replica("b")],
      observations: [observation("a")],
    });
    expect(snapshot.phaseMixture.unknown).toBe(0.5);
  });
  it("rejects duplicate observations and non-finite correlation", () => {
    const base = { campaignId: "c", groupId: "g", replicas: [], observations: [observation("a")] };
    expect(() =>
      buildPopulationSnapshot({ ...base, observations: [observation("a"), observation("a")] }),
    ).toThrow();
    expect(() => buildPopulationSnapshot({ ...base, meanCorrelation: Number.NaN })).toThrow();
  });
  it("recomputes phases instead of trusting edited derived projections", () => {
    const snapshot = buildPopulationSnapshot({
      campaignId: "c",
      groupId: "g",
      replicas: [],
      observations: [observation("jam", { resourcePressure: 0.95 })],
    });
    snapshot.phaseMixture.jammed = 0;
    snapshot.resourcePressure = 0;
    expect(assessPopulation(snapshot).actions[0]?.kind).toBe("drain");
  });
});