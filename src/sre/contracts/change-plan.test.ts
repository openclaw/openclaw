import { describe, expect, it } from "vitest";
import { createChangePlanId, createRepoOwnershipMap } from "./change-plan.js";

describe("sre change plan contracts", () => {
  it("creates deterministic change plan ids regardless of repo order", () => {
    const left = createChangePlanId({
      incidentId: "incident-123",
      generatedAt: "2026-03-06T10:00:00.000Z",
      repoIds: ["morpho-infra-helm", "openclaw-sre"],
    });
    const right = createChangePlanId({
      incidentId: "incident-123",
      generatedAt: "2026-03-06T10:00:00.000Z",
      repoIds: ["openclaw-sre", "morpho-infra-helm"],
    });

    expect(left).toBe(right);
  });

  it("sorts repo ownership entries by repo id", () => {
    const map = createRepoOwnershipMap({
      generatedAt: "2026-03-06T10:00:00.000Z",
      repos: [
        {
          repoId: "openclaw-sre",
          localPath: "/Users/florian/morpho/openclaw-sre",
          ownedGlobs: ["src/**"],
          sourceOfTruthDomains: ["runtime-core"],
          dependentRepos: ["morpho-infra-helm"],
          ciChecks: ["pnpm build"],
          validationCommands: ["pnpm test -- src/sre/contracts"],
          rollbackHints: ["revert runtime patch"],
        },
        {
          repoId: "morpho-infra-helm",
          localPath: "/Users/florian/morpho/morpho-infra-helm",
          ownedGlobs: ["charts/openclaw-sre/**"],
          sourceOfTruthDomains: ["deploy-config"],
          dependentRepos: [],
          ciChecks: ["helm lint"],
          validationCommands: ["helm template"],
          rollbackHints: ["revert chart values"],
        },
      ],
    });

    expect(map.version).toBe("sre.repo-ownership-map.v1");
    expect(map.repos.map((entry) => entry.repoId)).toEqual(["morpho-infra-helm", "openclaw-sre"]);
  });
});
