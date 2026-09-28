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
      // Strict default: stable evidence without blocking performance fails closed.
      name: "advisory performance",
      overrides: { controls: { performanceBlocking: false } },
      failures: ["performance"],
    },
    {
      name: "waived advisory and soak",
      overrides: { controls: { performanceBlocking: false }, runReleaseSoak: "false" },
      waiver: "2026.9.5 Approved after infrastructure failure",
      failures: ["performance", "soak"],
    },
    {
      name: "waiver naming another release train",
      overrides: { runReleaseSoak: "false" },
      waiver: "2026.9.7 Approved",
      failures: ["soak"],
    },
    {
      name: "blank waiver",
      overrides: { runReleaseSoak: "false" },
      waiver: " \n\t",
      failures: ["soak"],
    },
    {
      name: "failed advisory performance",
      overrides: {
        controls: { performanceBlocking: false },
        childRuns: { productPerformance: { conclusion: "failure" } },
      },
      failures: ["performance"],
    },
    {
      // A waiver cannot stand in for a performance child that failed.
      name: "waived failed advisory performance",
      overrides: {
        controls: { performanceBlocking: false },
        childRuns: { productPerformance: { conclusion: "failure" } },
      },
      waiver: "2026.9.5 Approved",
      failures: ["performance"],
    },
    {
      name: "missing performance evidence",
      overrides: { controls: {}, childRuns: {} },
      failures: ["performance"],
    },
  ])("evaluates every publication consumer for $name", ({ overrides, waiver, failures }) => {
    for (const consumer of ["publisher", "core-npm", "stable-closeout"] as const) {
      const gates = evaluateReleasePublishGates({
        manifest: { ...manifest, ...overrides },
        consumer,
        releaseTag: "v2026.9.5",
        npmDistTag: "latest",
        ...(waiver ? { stableSoakWaiver: waiver } : {}),
        expectedSha: targetSha,
      });
      expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual(
        failures.map((id) => `${consumer}.${id}`),
      );
    }
  });

  it("does not require deferred performance for beta tags published to beta", () => {
    const input = {
      manifest: {
        ...manifest,
        releaseProfile: "beta",
        controls: { performanceBlocking: false },
        childRuns: {},
      },
      releaseTag: "v2026.9.5-beta.1",
      npmDistTag: "beta",
    };
    for (const consumer of ["publisher", "core-npm"] as const) {
      expect(
        evaluateReleasePublishGates({ ...input, consumer }).filter(
          (gate) => gate.status === "FAIL",
        ),
      ).toEqual([]);
    }
  });

  it("retains strict stable closeout soak evidence", () => {
    const input = {
      manifest: { ...manifest, runReleaseSoak: true },
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

  it.each(["publisher", "core-npm", "stable-closeout"] as const)(
    "rejects beta evidence for stable publication at %s even with historical waiver inputs",
    (consumer) => {
      const historicalInput = {
        consumer,
        releaseTag: "v2026.9.5",
        npmDistTag: "latest",
        manifest: {
          ...manifest,
          releaseProfile: "beta",
          runReleaseSoak: "false",
          controls: { performanceBlocking: false },
        },
        stableSoakWaiver: "2026.9.5 approved",
        laneWaiver: "2026.9.5 approved",
        publishAcceptedWaivers: {
          stableSoakWaiver: "2026.9.5 approved",
          laneWaiver: "2026.9.5 approved",
        },
      };
      const gates = evaluateReleasePublishGates(historicalInput);
      expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual([
        `${consumer}.performance`,
        `${consumer}.stable-profile`,
        `${consumer}.soak`,
      ]);
    },
  );

  it.each([
    { validationInputs: { laneWaiver: "2026.9.5 approved" } },
    { publishInputs: { stableSoakWaiver: "2026.9.5 approved" } },
    { advisoryJobs: [{ child: "normalCi", job: "tests", conclusion: "failure" }] },
  ])("rejects recorded waived or advisory evidence: %j", (recorded) => {
    for (const releaseTag of ["v2026.9.5", "v2026.9.5-beta.1"]) {
      const gates = evaluateReleasePublishGates({
        consumer: "publisher",
        releaseTag,
        npmDistTag: releaseTag.includes("beta") ? "beta" : "latest",
        manifest: { ...manifest, ...recorded },
      });
      expect(gates).toContainEqual(
        expect.objectContaining({ id: "publisher.selected-lanes", status: "FAIL" }),
      );
    }
  });

  it.each([false, true])(
    "runs without installed dependencies and never emits waiver authority (waived=%s)",
    (waived) => {
      const root = tempRoots.make("release-publish-gates-");
      const manifestPath = join(root, "manifest.json");
      const output = join(root, "output");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          sourceAdmission: {
            validationPurpose: "publish",
            publicationSelection: { npmDistTag: "latest" },
            projection: { packages: [] },
          },
          publishInputs: {
            version: 1,
            targetSha,
            npmDistTag: "latest",
            pluginSdkApiEvidenceDigest: "a".repeat(64),
            pluginSdkApiAcknowledgement: "aaaaaaaa",
            npmDecisions: [],
            ...(waived ? { stableSoakWaiver: "2026.9.5 approved" } : {}),
          },
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
            GITHUB_OUTPUT: output,
          },
        },
      );
      if (waived) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("waivers are no longer supported");
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8").split("\n")).toEqual([
          "plugin_sdk_api_acknowledgement=aaaaaaaa",
          "npm_decisions=[]",
          "release_profile=stable",
          "coverage_policy=full",
          "",
        ]);
      }
    },
  );
});
