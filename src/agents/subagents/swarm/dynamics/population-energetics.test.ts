import { describe, expect, it } from "vitest";
import { planEnergeticLaunch, type AgentEnergeticObservation } from "./population-energetics.js";

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

function plan(patch: Partial<AgentEnergeticObservation>, peers: AgentEnergeticObservation[] = []) {
  const target = observation("target", patch);
  const { replicaId, ...state } = target;
  return planEnergeticLaunch({ replicaId, state, peers });
}

describe("population energetics", () => {
  it("keeps energy and temperature orthogonal", () => {
    const explorer = plan({
      energy: 0.2,
      temperature: 0.9,
      mobility: 0.8,
      noveltyRate: 0.8,
      correlation: 0.1,
    });
    const verifier = plan({
      energy: 0.95,
      temperature: 0.05,
      mobility: 0.05,
      noveltyRate: 0.05,
      evidenceCompleteness: 0.95,
      verifierDisagreement: 0.05,
      correlation: 0.9,
    });

    expect(explorer).toMatchObject({
      energyLevel: "low",
      regime: "gas",
      thinking: "low",
      fastMode: true,
    });
    expect(verifier).toMatchObject({
      energyLevel: "high",
      regime: "crystal",
      thinking: "high",
      fastMode: false,
    });
  });

  it("reheats a high-energy glass instead of allocating still more energy", () => {
    const glass = plan({
      energy: 0.9,
      temperature: 0.15,
      mobility: 0.05,
      noveltyRate: 0.05,
      evidenceCompleteness: 0.3,
      correlation: 0.95,
    });

    expect(glass).toMatchObject({
      regime: "glass",
      energyLevel: "high",
      actionKinds: ["reheat"],
      thinking: "high",
      fastMode: false,
    });
    expect(glass.directive).toContain("breaking correlation");
  });

  it("moves informative disagreement into high-energy measurement", () => {
    const critical = plan({
      energy: 0.45,
      temperature: 0.5,
      verifierDisagreement: 0.85,
      susceptibility: 0.75,
    });

    expect(critical).toMatchObject({
      regime: "critical",
      actionKinds: ["measure", "deepen"],
      thinking: "high",
      fastMode: false,
    });
    expect(critical.directive).toContain("discriminating measurement");
  });

  it("preserves local regimes and discounts correlated peer count", () => {
    expect(
      plan({
        energy: 0.2,
        temperature: 0.9,
        mobility: 0.8,
        noveltyRate: 0.9,
        correlation: 0.1,
      }).regime,
    ).toBe("gas");
    expect(
      plan({
        energy: 0.9,
        temperature: 0.05,
        mobility: 0.05,
        evidenceCompleteness: 0.95,
        verifierDisagreement: 0.05,
        correlation: 0.9,
      }).regime,
    ).toBe("crystal");
    expect(
      plan({
        energy: 0.85,
        temperature: 0.15,
        mobility: 0.05,
        noveltyRate: 0.05,
        evidenceCompleteness: 0.3,
        correlation: 0.9,
      }).regime,
    ).toBe("glass");

    const correlated = plan(
      {
        energy: 0.2,
        temperature: 0.9,
        mobility: 0.8,
        noveltyRate: 0.9,
        correlation: 0.9,
      },
      [
        observation("peer-a", { correlation: 0.9 }),
        observation("peer-b", { correlation: 0.9 }),
        observation("peer-c", { correlation: 0.9 }),
      ],
    );
    expect(correlated.effectivePopulationSize).not.toBeNull();
    expect(correlated.effectivePopulationSize).toBeLessThan(2);
  });

  it("suppresses a jammed launch", () => {
    const jammed = plan({
      energy: 0.8,
      temperature: 0.5,
      mobility: 0.5,
      noveltyRate: 0.5,
      evidenceCompleteness: 0.5,
      verifierDisagreement: 0.1,
      correlation: 0.5,
      susceptibility: 0.1,
      resourcePressure: 0.95,
    });
    expect(jammed).toMatchObject({
      regime: "jammed",
      actionKinds: ["drain"],
      suppressSpawn: true,
    });
  });
});
