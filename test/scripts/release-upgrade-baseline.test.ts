import { describe, expect, it } from "vitest";
import {
  parseArgs,
  resolveReleaseUpgradeBaseline,
  resolveQualificationBaselines,
  validateQualificationBaselines,
} from "../../scripts/lib/release-upgrade-baseline.mjs";

describe("release upgrade baseline resolver", () => {
  it("captures supported predecessors relative to the candidate, never future registry tags", () => {
    const captured = resolveQualificationBaselines({
      candidateVersion: "2026.8.4",
      targetContextRef: "release/2026.8.4",
      oldestSupportedVersion: "2026.6.34",
      publishedVersions: ["2026.6.34", "2026.7.34", "2026.8.2", "2026.8.3", "2026.8.4", "2026.9.1"],
    });
    expect(captured).toEqual({
      upgradeBaseline: "openclaw@2026.8.3",
      upgradeSurvivorBaselines: [
        "openclaw@2026.6.34",
        "openclaw@2026.7.34",
        "openclaw@2026.8.2",
        "openclaw@2026.8.3",
      ],
    });
    // Recovery validates retained inputs without another registry snapshot.
    expect(validateQualificationBaselines(captured, { candidateVersion: "2026.8.4" })).toEqual(
      captured,
    );
  });

  it("keeps extended-stable qualification baselines within the frozen release month", () => {
    expect(
      resolveQualificationBaselines({
        candidateVersion: "2026.8.35",
        targetContextRef: "extended-stable/2026.8.33",
        oldestSupportedVersion: "2026.6.34",
        publishedVersions: ["2026.6.34", "2026.8.33", "2026.8.34", "2026.9.1"],
      }),
    ).toEqual({
      upgradeBaseline: "openclaw@2026.8.34",
      upgradeSurvivorBaselines: ["openclaw@2026.8.34"],
    });
  });

  it.each(["openclaw@2026.8.3-beta.1", "openclaw@2026.9.1"])(
    "rejects mutable or incompatible captured baseline %s",
    (baseline) => {
      expect(() =>
        validateQualificationBaselines(
          {
            upgradeBaseline: baseline,
            upgradeSurvivorBaselines: [baseline],
          },
          { candidateVersion: "2026.8.4" },
        ),
      ).toThrow();
    },
  );

  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--candidate-version", "-h"])).toThrow(
      "missing value for --candidate-version",
    );
    expect(() => parseArgs(["--versions-json", "-h"])).toThrow("missing value for --versions-json");
  });

  it("selects the stable predecessor of a beta candidate", () => {
    expect(
      resolveReleaseUpgradeBaseline("2026.8.1-beta.2", [
        "2026.8.1-beta.1",
        "2026.7.1-1",
        "2026.9.1",
        "2026.8.1-alpha.1",
        "2026.7.1-2",
        "2026.6.34",
        "2026.7.1",
        "2026.8.1",
        "2026.7.1-beta.2",
        "2026.7.1-2",
      ]),
    ).toBe("openclaw@2026.7.1-2");
  });

  it("rejects missing stable baselines", () => {
    expect(() => resolveReleaseUpgradeBaseline("2026.7.1", ["2026.8.1", "invalid"])).toThrow(
      "no published stable OpenClaw baseline",
    );
  });

  it("requires a published candidate to occur in the same npm versions snapshot", () => {
    expect(() =>
      resolveReleaseUpgradeBaseline("2026.8.1-beta.2", ["2026.7.1", "2026.8.1-beta.1"], {
        candidatePublished: true,
      }),
    ).toThrow("published candidate 2026.8.1-beta.2 is absent from npm versions");
  });

  it("selects the latest stable release from the frozen release month", () => {
    expect(
      resolveReleaseUpgradeBaseline(
        "2026.6.35",
        ["2026.6.34", "2026.6.33", "2026.6.35", "2026.7.1", "2026.6.34-1"],
        {
          targetContextRef: "extended-stable/2026.6.33",
        },
      ),
    ).toBe("openclaw@2026.6.34-1");
  });

  it("selects a stable predecessor for the first frozen .33 candidate", () => {
    expect(
      resolveReleaseUpgradeBaseline(
        "2026.7.33",
        ["2026.6.34", "2026.7.1", "2026.7.1-1", "2026.7.1-2", "2026.8.1"],
        {
          targetContextRef: "extended-stable/2026.7.33",
        },
      ),
    ).toBe("openclaw@2026.7.1-2");
  });

  it("rejects an incompatible explicit frozen baseline", () => {
    expect(() =>
      resolveReleaseUpgradeBaseline("2026.6.35", ["2026.6.33", "2026.6.34", "2026.6.35"], {
        previousVersion: "2026.6.35",
        targetContextRef: "extended-stable/2026.6.33",
      }),
    ).toThrow("previous_version");
  });

  it.each([
    ["2026.6.35-beta.1", "extended-stable/2026.6.33"],
    ["2026.6.33", "extended-stable/2026.6.33"],
    ["2026.6.35", "extended-stable/2026.6.34"],
  ])(
    "rejects incompatible frozen extended-stable targets",
    (candidateVersion, targetContextRef) => {
      expect(() =>
        resolveReleaseUpgradeBaseline(candidateVersion, ["2026.6.34", "2026.6.33"], {
          targetContextRef,
        }),
      ).toThrow();
    },
  );
});
