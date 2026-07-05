import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  loadExtendedStablePluginCohort,
  parseExtendedStablePluginCohort,
} from "./extended-stable-plugin-cohort.js";

const tempDirs = new Set<string>();

afterEach(() => cleanupTempDirs(tempDirs));

describe("extended-stable plugin cohort metadata", () => {
  it("loads the closed monthly baseline schema", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-plugin-cohort-");
    mkdirSync(join(rootDir, "release"));
    writeFileSync(
      join(rootDir, "release/extended-stable-plugin-cohort.json"),
      `${JSON.stringify({ schemaVersion: 1, releaseLine: "2026.6", baselineVersion: "2026.6.21" })}\n`,
    );

    expect(loadExtendedStablePluginCohort(rootDir)).toEqual({
      schemaVersion: 1,
      releaseLine: "2026.6",
      baselineVersion: "2026.6.21",
    });
  });

  it("rejects extra fields, cross-line baselines, and activation patches", () => {
    expect(() =>
      parseExtendedStablePluginCohort({
        schemaVersion: 1,
        releaseLine: "2026.6",
        baselineVersion: "2026.6.21",
        packages: [],
      }),
    ).toThrow(/exactly/u);
    expect(() =>
      parseExtendedStablePluginCohort({
        schemaVersion: 1,
        releaseLine: "2026.6",
        baselineVersion: "2026.7.21",
      }),
    ).toThrow(/same release line/u);
    expect(() =>
      parseExtendedStablePluginCohort({
        schemaVersion: 1,
        releaseLine: "2026.6",
        baselineVersion: "2026.6.33",
      }),
    ).toThrow(/patch below 33/u);
  });
});
