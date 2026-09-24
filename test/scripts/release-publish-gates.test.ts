import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateReleaseBootstrapGate,
  evaluateReleasePublishGates,
} from "../../scripts/lib/release-publish-gates.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const targetSha = "a".repeat(40);
const manifest = {
  workflowName: "Full Release Validation",
  targetSha,
  releaseProfile: "stable",
  rerunGroup: "all",
  runReleaseSoak: "true",
  controls: { performanceBlocking: true },
  childRuns: { productPerformance: { conclusion: "success" } },
  validationInputs: { coveragePolicy: "full" },
};

describe("release publication control admission", () => {
  it("rejects stable bootstrap approval that cannot cover the candidate package version", () => {
    const input = {
      releaseTag: "v2026.9.5",
      publishTag: "latest",
      releaseProfile: "stable",
      packageVersion: "2026.9.4",
    };
    expect(evaluateReleaseBootstrapGate(input).status).toBe("FAIL");
  });

  it.each([
    { name: "stable evidence", overrides: {}, failures: [] },
    { name: "unsealed rerun", overrides: { rerunGroup: "performance" }, failures: ["rerun-group"] },
    { name: "missing soak", overrides: { runReleaseSoak: "false" }, failures: ["soak"] },
    {
      name: "advisory performance",
      overrides: { controls: { performanceBlocking: false } },
      failures: ["performance"],
    },
    { name: "full evidence", overrides: { releaseProfile: "full" }, failures: [] },
    {
      name: "beta profile cannot publish stable even with soak",
      overrides: { releaseProfile: "beta" },
      failures: ["stable-profile"],
    },
  ])("evaluates every parent and core gate for $name", ({ overrides, failures }) => {
    for (const consumer of ["publisher", "core-npm", "stable-closeout"] as const) {
      const gates = evaluateReleasePublishGates({
        manifest: { ...manifest, ...overrides },
        consumer,
        releaseTag: "v2026.9.5",
        npmDistTag: "latest",
        expectedSha: targetSha,
      });
      expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual(
        failures.map((id) => `${consumer}.${id}`),
      );
    }
  });

  it("preserves beta publication without soak or blocking performance", () => {
    for (const consumer of ["publisher", "core-npm"] as const) {
      const gates = evaluateReleasePublishGates({
        manifest: {
          ...manifest,
          releaseProfile: "beta",
          runReleaseSoak: "false",
          controls: { performanceBlocking: false },
        },
        releaseTag: "v2026.9.5-beta.1",
        npmDistTag: "beta",
        consumer,
      });
      expect(gates.some((gate) => gate.status === "FAIL")).toBe(false);
    }
  });

  it.each([
    { controls: { performanceBlocking: "true" } },
    { runReleaseSoak: true },
    { childRuns: { productPerformance: { conclusion: "failure" } } },
  ])("retains stricter stable closeout controls: %j", (overrides) => {
    const input = {
      manifest: { ...manifest, ...overrides },
      releaseTag: "v2026.9.5",
      npmDistTag: "latest",
    };
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "publisher" }).some(
        (gate) => gate.status === "FAIL",
      ),
    ).toBe(false);
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "stable-closeout" }).some(
        (gate) => gate.status === "FAIL",
      ),
    ).toBe(true);
  });

  it("reports independent identity and policy failures together", () => {
    const gates = evaluateReleasePublishGates({
      manifest: {
        ...manifest,
        workflowName: "Other",
        targetSha: "b".repeat(40),
        rerunGroup: "performance",
        runReleaseSoak: "false",
      },
      consumer: "publisher",
      releaseTag: "v2026.9.5",
      npmDistTag: "latest",
      expectedSha: targetSha,
      expectedReleaseProfile: "full",
    });
    expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual([
      "publisher.workflow",
      "publisher.target",
      "publisher.profile",
      "publisher.rerun-group",
      "publisher.soak",
    ]);
  });

  it.each([
    { name: "qualified stable", overrides: {}, exitCode: 0 },
    {
      name: "unsoaked stable with a legacy waiver",
      overrides: { runReleaseSoak: "false" },
      exitCode: 1,
    },
    {
      name: "advisory performance with a legacy waiver",
      overrides: { controls: { performanceBlocking: false } },
      exitCode: 1,
    },
  ])("runs without installed dependencies: $name", ({ overrides, exitCode }) => {
    const root = tempRoots.make("release-publish-gates-");
    const manifestPath = join(root, "manifest.json");
    const output = join(root, "output");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...overrides }));
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/lib/release-publish-gates.mts"),
        "--consumer",
        "publisher",
        "--manifest",
        manifestPath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          RELEASE_TAG: "v2026.9.5",
          RELEASE_NPM_DIST_TAG: "latest",
          EXPECTED_SHA: targetSha,
          EXPECTED_RELEASE_PROFILE: "from-validation",
          STABLE_SOAK_WAIVER: "Approved",
          GITHUB_OUTPUT: output,
        },
      },
    );
    expect(result.status, result.stderr).toBe(exitCode);
    if (exitCode === 0) {
      expect(readFileSync(output, "utf8").split("\n")).toEqual([
        "release_profile=stable",
        "coverage_policy=full",
        "",
      ]);
    } else {
      expect(result.stderr).toMatch(
        /require.*runReleaseSoak=true|does not record blocking product performance/u,
      );
    }
  });
});
