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
    {
      name: "waived advisory and soak",
      overrides: { controls: { performanceBlocking: false }, runReleaseSoak: "false" },
      waiver: "Approved after infrastructure failure",
      failures: [],
    },
    {
      name: "blank waiver",
      overrides: { runReleaseSoak: "false" },
      waiver: " \n\t",
      failures: ["soak"],
    },
    {
      name: "failed waived performance",
      overrides: {
        controls: { performanceBlocking: false },
        childRuns: { productPerformance: { conclusion: "failure" } },
      },
      waiver: "Approved",
      failures: ["performance"],
    },
  ])("evaluates every parent and core gate for $name", ({ overrides, waiver, failures }) => {
    for (const consumer of ["publisher", "core-npm"] as const) {
      const gates = evaluateReleasePublishGates({
        manifest: { ...manifest, ...overrides },
        consumer,
        releaseTag: "v2026.9.5",
        npmDistTag: "latest",
        stableSoakWaiver: waiver,
        expectedSha: targetSha,
      });
      expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual(
        failures.map((id) => `${consumer}.${id}`),
      );
    }
  });

  it.each([
    { npmDistTag: "latest", failures: ["core-npm.performance"] },
    { npmDistTag: "beta", failures: [] },
  ])("preserves beta-profile parent and $npmDistTag core admission", ({ npmDistTag, failures }) => {
    const input = {
      manifest: { ...manifest, releaseProfile: "beta", controls: { performanceBlocking: false } },
      releaseTag: "v2026.9.5",
      npmDistTag,
    };
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "publisher" }).some(
        (gate) => gate.status === "FAIL",
      ),
    ).toBe(false);
    expect(
      evaluateReleasePublishGates({ ...input, consumer: "core-npm" })
        .filter((gate) => gate.status === "FAIL")
        .map((gate) => gate.id),
    ).toEqual(failures);
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

  it("runs without installed dependencies and preserves escaped workflow waiver outputs", () => {
    const root = tempRoots.make("release-publish-gates-");
    const manifestPath = join(root, "manifest.json");
    const output = join(root, "output");
    const summary = join(root, "summary");
    const waiver = 'Infrastructure 100% unavailable\nOperator "approved"';
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        runReleaseSoak: "false",
        controls: { performanceBlocking: false },
      }),
    );
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
          STABLE_SOAK_WAIVER: waiver,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Infrastructure 100%25 unavailable%0AOperator "approved"');
    expect(readFileSync(output, "utf8").split("\n")).toEqual([
      `stable_soak_waiver=${JSON.stringify(waiver)}`,
      `stable_soak_waiver=${JSON.stringify(waiver)}`,
      "release_profile=stable",
      "coverage_policy=full",
      "",
    ]);
    expect(readFileSync(summary, "utf8")).toBe(`- Stable soak waived by operator: ${waiver}\n`);
  });
});
