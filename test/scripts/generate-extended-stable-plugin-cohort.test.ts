import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectAllPublishablePluginPackageNames,
  collectExtendedStableCohortPackageNames,
  generateExtendedStablePluginCohort,
  selectExtendedStablePluginCohort,
} from "../../scripts/generate-extended-stable-plugin-cohort.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs = new Set<string>();
const packageNames = ["@openclaw/a", "@openclaw/b"];

afterEach(() => cleanupTempDirs(tempDirs));

function evidence(releaseVersion: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    releaseVersion,
    releaseTag: `v${releaseVersion}`,
    npmDistTag: "latest",
    pluginPublishScope: "all-publishable",
    openclawNpmIntegrity: "sha512-core",
    pluginNpmPackages: packageNames.map((packageName) => ({
      packageName,
      version: releaseVersion,
      npmIntegrity: `sha512-${packageName.at(-1)}`,
    })),
    ...overrides,
  };
}

function writeEvidence(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
}

describe("monthly compatibility cohort generation", () => {
  it("derives the cohort from the official catalog and release-plan parity", () => {
    const allPublishable = collectAllPublishablePluginPackageNames();
    const cohort = collectExtendedStableCohortPackageNames();

    expect(cohort.length).toBe(allPublishable.length - 3);
    expect(cohort).not.toContain("@openclaw/codex");
    expect(cohort).not.toContain("@openclaw/discord");
    expect(cohort).not.toContain("@openclaw/slack");
  });

  it("selects the greatest eligible successful same-month full release", () => {
    expect(
      selectExtendedStablePluginCohort({
        releaseVersion: "2026.6.33",
        expectedPackageNames: packageNames,
        evidence: [
          evidence("2026.6.12"),
          evidence("2026.6.21"),
          evidence("2026.6.22", { pluginPublishScope: "selected" }),
          evidence("2026.5.31"),
        ],
      }),
    ).toEqual({ schemaVersion: 1, releaseLine: "2026.6", baselineVersion: "2026.6.21" });
  });

  it("writes only the first .33 activation and keeps .34+ immutable", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-root-");
    const evidenceDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-evidence-");
    mkdirSync(join(rootDir, "release"));
    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.6.33"}\n');
    writeEvidence(evidenceDir, "12.json", evidence("2026.6.12"));
    writeEvidence(evidenceDir, "21.json", evidence("2026.6.21"));

    expect(
      generateExtendedStablePluginCohort({
        rootDir,
        evidenceDir,
        expectedPackageNames: packageNames,
        fix: true,
      }),
    ).toEqual({ action: "written", baselineVersion: "2026.6.21" });
    expect(
      JSON.parse(readFileSync(join(rootDir, "release/extended-stable-plugin-cohort.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, releaseLine: "2026.6", baselineVersion: "2026.6.21" });

    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.6.34"}\n');
    expect(
      generateExtendedStablePluginCohort({
        rootDir,
        evidenceDir,
        expectedPackageNames: packageNames,
        fix: true,
      }),
    ).toEqual({ action: "verified", baselineVersion: "2026.6.21" });
  });

  it("does not invent or require cohort metadata before patch 33", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-preactivation-");
    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.6.21"}\n');

    expect(
      generateExtendedStablePluginCohort({
        rootDir,
        expectedPackageNames: packageNames,
        fix: true,
      }),
    ).toEqual({ action: "not-required" });
  });

  it("does not apply cohort generation to prerelease or correction versions", () => {
    for (const version of ["2026.6.22-beta.1", "2026.6.21-1"]) {
      const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-nonfinal-");
      writeFileSync(join(rootDir, "package.json"), `${JSON.stringify({ version })}\n`);
      expect(
        generateExtendedStablePluginCohort({
          rootDir,
          expectedPackageNames: packageNames,
          fix: true,
        }),
      ).toEqual({ action: "not-required" });
    }
  });

  it("replaces the previous month's cohort on a new .33 activation", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-rollover-");
    const evidenceDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-rollover-evidence-");
    mkdirSync(join(rootDir, "release"));
    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.7.33"}\n');
    writeFileSync(
      join(rootDir, "release/extended-stable-plugin-cohort.json"),
      '{"schemaVersion":1,"releaseLine":"2026.6","baselineVersion":"2026.6.21"}\n',
    );
    writeEvidence(evidenceDir, "22.json", evidence("2026.7.22"));

    expect(
      generateExtendedStablePluginCohort({
        rootDir,
        evidenceDir,
        expectedPackageNames: packageNames,
        fix: true,
      }),
    ).toEqual({ action: "written", baselineVersion: "2026.7.22" });
    expect(
      JSON.parse(readFileSync(join(rootDir, "release/extended-stable-plugin-cohort.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, releaseLine: "2026.7", baselineVersion: "2026.7.22" });
  });

  it("rejects .33 check mode without generated metadata and .34 baseline drift", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-drift-");
    const evidenceDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-drift-evidence-");
    mkdirSync(join(rootDir, "release"));
    writeEvidence(evidenceDir, "21.json", evidence("2026.6.21"));
    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.6.33"}\n');

    expect(() =>
      generateExtendedStablePluginCohort({
        rootDir,
        evidenceDir,
        expectedPackageNames: packageNames,
        fix: false,
      }),
    ).toThrow(/requires --fix/u);

    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.6.34"}\n');
    writeFileSync(
      join(rootDir, "release/extended-stable-plugin-cohort.json"),
      '{"schemaVersion":1,"releaseLine":"2026.6","baselineVersion":"2026.6.20"}\n',
    );
    expect(() =>
      generateExtendedStablePluginCohort({
        rootDir,
        evidenceDir,
        expectedPackageNames: packageNames,
        fix: true,
      }),
    ).toThrow(/immutable/u);
  });

  it("requires immutable source evidence for every patch 33+ check", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-proof-required-");
    mkdirSync(join(rootDir, "release"));
    writeFileSync(join(rootDir, "package.json"), '{"version":"2026.6.34"}\n');
    writeFileSync(
      join(rootDir, "release/extended-stable-plugin-cohort.json"),
      '{"schemaVersion":1,"releaseLine":"2026.6","baselineVersion":"2026.6.21"}\n',
    );

    expect(() =>
      generateExtendedStablePluginCohort({
        rootDir,
        expectedPackageNames: packageNames,
        fix: false,
      }),
    ).toThrow(/requires --cohort-evidence-dir/u);
  });
});
