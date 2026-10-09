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

  // Today's 2026.9.33 line: extended-stable installs sit on 2026.8.35 until it publishes.
  const septemberLine = {
    candidateVersion: "2026.9.33",
    oldestSupportedVersion: "2026.6.34",
    publishedVersions: [
      "2026.6.34",
      "2026.7.35",
      "2026.8.9",
      "2026.8.33",
      "2026.8.34",
      "2026.8.35",
      "2026.9.8",
      "2026.9.9",
      "2026.10.1",
      "2026.10.5-beta.3",
    ],
  };

  it("upgrades a first frozen .33 candidate from the previous extended-stable release", () => {
    const captured = resolveQualificationBaselines({
      ...septemberLine,
      targetContextRef: "extended-stable/2026.9.33",
    });
    expect(captured).toEqual({
      upgradeBaseline: "openclaw@2026.8.35",
      upgradeSurvivorBaselines: ["openclaw@2026.8.35", "openclaw@2026.9.9"],
    });
    // Admission, publication, and workflow consumers revalidate the retained tuple.
    expect(
      validateQualificationBaselines(captured, {
        candidateVersion: "2026.9.33",
        targetContextRef: "extended-stable/2026.9.33",
      }),
    ).toEqual(captured);
    expect(
      resolveReleaseUpgradeBaseline("2026.9.33", septemberLine.publishedVersions, {
        targetContextRef: "extended-stable/2026.9.33",
      }),
    ).toBe("openclaw@2026.8.35");
    // Cross-OS re-resolves the captured primary as an explicit previous_version.
    expect(
      resolveReleaseUpgradeBaseline("2026.9.33", septemberLine.publishedVersions, {
        previousVersion: "2026.8.35",
        targetContextRef: "extended-stable/2026.9.33",
      }),
    ).toBe("openclaw@2026.8.35");
  });

  it("prefers the extended-stable predecessor for a .33 candidate outside its branch context", () => {
    expect(
      resolveQualificationBaselines({ ...septemberLine, targetContextRef: "v2026.9.33" }),
    ).toEqual({
      upgradeBaseline: "openclaw@2026.8.35",
      upgradeSurvivorBaselines: [
        "openclaw@2026.6.34",
        "openclaw@2026.8.35",
        "openclaw@2026.9.8",
        "openclaw@2026.9.9",
      ],
    });
  });

  it("keeps later frozen candidates on their newest extended-stable predecessor", () => {
    expect(
      resolveQualificationBaselines({
        ...septemberLine,
        candidateVersion: "2026.9.34",
        targetContextRef: "extended-stable/2026.9.33",
        publishedVersions: [...septemberLine.publishedVersions, "2026.9.33"],
      }),
    ).toEqual({
      upgradeBaseline: "openclaw@2026.9.33",
      upgradeSurvivorBaselines: ["openclaw@2026.9.33"],
    });
  });

  it.each([
    {
      name: "a same-month primary beside the extended-stable predecessor",
      upgradeBaseline: "openclaw@2026.9.9",
    },
    {
      name: "an older extended-stable primary",
      upgradeBaseline: "openclaw@2026.8.34",
      extra: "openclaw@2026.8.34",
    },
  ])("rejects $name for a frozen .33 candidate", ({ upgradeBaseline, extra }) => {
    expect(() =>
      validateQualificationBaselines(
        {
          upgradeBaseline,
          upgradeSurvivorBaselines: [
            "openclaw@2026.8.35",
            "openclaw@2026.9.9",
            ...(extra ? [extra] : []),
          ],
        },
        { candidateVersion: "2026.9.33", targetContextRef: "extended-stable/2026.9.33" },
      ),
    ).toThrow("newest selected predecessor");
  });

  it("rejects a regular stable primary that is not the newest survivor", () => {
    expect(() =>
      validateQualificationBaselines(
        {
          upgradeBaseline: "openclaw@2026.8.2",
          upgradeSurvivorBaselines: ["openclaw@2026.8.2", "openclaw@2026.8.3"],
        },
        { candidateVersion: "2026.8.4" },
      ),
    ).toThrow("newest selected predecessor");
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

  it("selects the selector-servable extended-stable predecessor over a historical correction", () => {
    expect(
      resolveReleaseUpgradeBaseline(
        "2026.6.35",
        ["2026.6.34", "2026.6.33", "2026.6.35", "2026.7.1", "2026.6.34-1"],
        {
          targetContextRef: "extended-stable/2026.6.33",
        },
      ),
    ).toBe("openclaw@2026.6.34");
  });

  it.each([
    {
      published: ["2026.6.34", "2026.7.1", "2026.7.1-1", "2026.7.1-2", "2026.8.1"],
      baseline: "openclaw@2026.6.34",
    },
    {
      published: ["2026.6.9", "2026.7.1", "2026.7.1-1", "2026.7.1-2", "2026.8.1"],
      baseline: "openclaw@2026.7.1-2",
    },
  ])("selects $baseline for the first frozen .33 candidate", ({ published, baseline }) => {
    expect(
      resolveReleaseUpgradeBaseline("2026.7.33", published, {
        targetContextRef: "extended-stable/2026.7.33",
      }),
    ).toBe(baseline);
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
