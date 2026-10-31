import { describe, expect, it } from "vitest";
import {
  parseArgs,
  resolveReleaseUpgradeBaseline,
  resolveQualificationBaselines,
  validateQualificationBaselines,
} from "../../scripts/lib/release-upgrade-baseline.mjs";

const baselines = (primary: string, survivors: readonly string[] = [primary]) => ({
  upgradeBaseline: `openclaw@${primary}`,
  upgradeSurvivorBaselines: survivors.map((version) => `openclaw@${version}`),
});
const frozenContext = {
  candidateVersion: "2026.9.33",
  targetContextRef: "extended-stable/2026.9.33",
};
const regularContext = { candidateVersion: "2026.8.4" };
const juneContext = { targetContextRef: "extended-stable/2026.6.33" };
const juneVersions = ["2026.6.34", "2026.6.33"];
const versions = (list: string) => list.split(" ");
const septemberLine = {
  ...frozenContext,
  oldestSupportedVersion: "2026.6.34",
  publishedVersions: versions(
    "2026.6.34 2026.7.35 2026.8.9 2026.8.33 2026.8.34 2026.8.35 2026.9.8 2026.9.9 2026.10.1 2026.10.5-beta.3",
  ),
};

describe("release upgrade baseline resolver", () => {
  it.each([
    [
      "captures supported predecessors, never future registry tags",
      {
        ...regularContext,
        targetContextRef: "release/2026.8.4",
        publishedVersions: versions("2026.6.34 2026.7.34 2026.8.2 2026.8.3 2026.8.4 2026.9.1"),
      },
      baselines("2026.8.3", ["2026.6.34", "2026.7.34", "2026.8.2", "2026.8.3"]),
    ],
    [
      "keeps qualification within the frozen release month",
      {
        candidateVersion: "2026.8.35",
        targetContextRef: "extended-stable/2026.8.33",
        publishedVersions: ["2026.6.34", "2026.8.33", "2026.8.34", "2026.9.1"],
      },
      baselines("2026.8.34"),
    ],
    [
      "prefers the frozen predecessor outside its branch context",
      { targetContextRef: "v2026.9.33" },
      baselines("2026.8.35", ["2026.6.34", "2026.8.35", "2026.9.8", "2026.9.9"]),
    ],
    [
      "keeps later frozen candidates on their newest frozen predecessor",
      {
        candidateVersion: "2026.9.34",
        publishedVersions: [...septemberLine.publishedVersions, "2026.9.33"],
      },
      baselines("2026.9.33"),
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveQualificationBaselines({ ...septemberLine, ...overrides })).toEqual(expected);
  });

  it("upgrades a first frozen .33 from the previous frozen line, including explicit selection", () => {
    expect(resolveQualificationBaselines(septemberLine)).toEqual(
      baselines("2026.8.35", ["2026.8.35", "2026.9.9"]),
    );
    expect(
      resolveReleaseUpgradeBaseline("2026.9.33", septemberLine.publishedVersions, {
        ...frozenContext,
        previousVersion: "2026.8.35",
      }),
    ).toBe("openclaw@2026.8.35");
  });

  it.each([
    ["same-month frozen primary", "2026.9.9", ["2026.8.35", "2026.9.9"], frozenContext],
    ["older regular primary", "2026.8.2", ["2026.8.2", "2026.8.3"], regularContext],
  ] as const)("rejects %s", (_name, primary, survivors, context) => {
    expect(() => validateQualificationBaselines(baselines(primary, survivors), context)).toThrow(
      "newest selected predecessor",
    );
  });

  it.each(["2026.8.3-beta.1", "2026.9.1"])(
    "rejects mutable or incompatible captured baseline %s",
    (baseline) => {
      expect(() => validateQualificationBaselines(baselines(baseline), regularContext)).toThrow();
    },
  );

  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--candidate-version", "-h"])).toThrow(
      "missing value for --candidate-version",
    );
  });

  it("selects the stable predecessor of a beta candidate", () => {
    expect(
      resolveReleaseUpgradeBaseline(
        "2026.8.1-beta.2",
        versions(
          "2026.8.1-beta.1 2026.8.1-alpha.1 2026.7.1-1 2026.7.1-2 2026.7.1 2026.8.1 2026.7.1-beta.2",
        ),
      ),
    ).toBe("openclaw@2026.7.1-2");
  });

  it("selects the selector-servable extended-stable predecessor over a historical correction", () => {
    expect(
      resolveReleaseUpgradeBaseline(
        "2026.6.35",
        ["2026.6.34", "2026.6.33", "2026.6.35", "2026.7.1", "2026.6.34-1"],
        juneContext,
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

  it.each([
    ["2026.7.1", ["2026.8.1", "invalid"], {}, "no published stable OpenClaw baseline"],
    [
      "2026.8.1-beta.2",
      ["2026.7.1", "2026.8.1-beta.1"],
      { candidatePublished: true },
      "published candidate 2026.8.1-beta.2 is absent from npm versions",
    ],
    [
      "2026.6.35",
      ["2026.6.33", "2026.6.34", "2026.6.35"],
      { ...juneContext, previousVersion: "2026.6.35" },
      "previous_version",
    ],
    ["2026.6.35-beta.1", juneVersions, juneContext, undefined],
    ["2026.6.33", juneVersions, juneContext, undefined],
    ["2026.6.35", juneVersions, { targetContextRef: "extended-stable/2026.6.34" }, undefined],
  ] as const)(
    "rejects an unavailable or incompatible baseline for %s (%j)",
    (candidate, published, context, error) => {
      expect(() => resolveReleaseUpgradeBaseline(candidate, published, context)).toThrow(error);
    },
  );
});
