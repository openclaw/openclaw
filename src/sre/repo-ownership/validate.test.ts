import { describe, expect, it } from "vitest";
import { validateRepoOwnershipMap, __test__ } from "./validate.js";

describe("validateRepoOwnershipMap", () => {
  it("accepts disjoint owned globs", () => {
    expect(() =>
      validateRepoOwnershipMap({
        version: "sre.repo-ownership-map.v1",
        generatedAt: "2026-03-06T12:00:00.000Z",
        repos: [
          {
            repoId: "openclaw-sre",
            localPath: "/tmp/openclaw-sre",
            ownedGlobs: ["src/**", "package.json"],
            sourceOfTruthDomains: ["runtime"],
            dependentRepos: ["morpho-infra-helm"],
            ciChecks: ["pnpm build"],
            validationCommands: ["pnpm test -- src/sre"],
            rollbackHints: ["revert runtime patch"],
          },
          {
            repoId: "morpho-infra-helm",
            localPath: "/tmp/morpho-infra-helm",
            ownedGlobs: ["charts/openclaw-sre/**"],
            sourceOfTruthDomains: ["chart"],
            dependentRepos: ["openclaw-sre"],
            ciChecks: ["helm template"],
            validationCommands: ["helm lint charts/openclaw-sre"],
            rollbackHints: ["revert chart patch"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects invalid globs", () => {
    expect(() =>
      validateRepoOwnershipMap({
        version: "sre.repo-ownership-map.v1",
        generatedAt: "2026-03-06T12:00:00.000Z",
        repos: [
          {
            repoId: "openclaw-sre",
            localPath: "/tmp/openclaw-sre",
            ownedGlobs: ["../src/**"],
            sourceOfTruthDomains: ["runtime"],
            dependentRepos: [],
            ciChecks: [],
            validationCommands: [],
            rollbackHints: [],
          },
        ],
      }),
    ).toThrow(/invalid repoOwnership glob/);
  });

  it("rejects overlapping globs across repos", () => {
    expect(() =>
      validateRepoOwnershipMap({
        version: "sre.repo-ownership-map.v1",
        generatedAt: "2026-03-06T12:00:00.000Z",
        repos: [
          {
            repoId: "openclaw-sre",
            localPath: "/tmp/openclaw-sre",
            ownedGlobs: ["charts/**"],
            sourceOfTruthDomains: ["runtime"],
            dependentRepos: [],
            ciChecks: [],
            validationCommands: [],
            rollbackHints: [],
          },
          {
            repoId: "morpho-infra-helm",
            localPath: "/tmp/morpho-infra-helm",
            ownedGlobs: ["charts/openclaw-sre/**"],
            sourceOfTruthDomains: ["chart"],
            dependentRepos: [],
            ciChecks: [],
            validationCommands: [],
            rollbackHints: [],
          },
        ],
      }),
    ).toThrow(/overlapping repoOwnership globs/);
  });

  it("normalizes slash variants for testing helpers", () => {
    expect(__test__.normalizeOwnedGlob(".\\src\\**")).toBe("./src/**".replace(/^\.\//, ""));
    expect(__test__.globsOverlap("charts/**", "charts/openclaw-sre/**")).toBe(true);
  });
});
