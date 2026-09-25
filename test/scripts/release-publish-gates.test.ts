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
      failures: [],
    },
    {
      name: "waiver naming another release train",
      overrides: { runReleaseSoak: "false" },
      waiver: "2026.9.7 Approved",
      failures: ["waiver-target"],
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
        stableSoakWaiver: waiver,
        expectedSha: targetSha,
      });
      expect(gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id)).toEqual(
        failures.map((id) => `${consumer}.${id}`),
      );
    }
  });

  it("keeps performance advisory for beta tags published to beta", () => {
    const input = {
      manifest: {
        ...manifest,
        releaseProfile: "beta",
        controls: { performanceBlocking: false },
        childRuns: { productPerformance: { conclusion: "failure" } },
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

  it("keeps a revoked sealed soak waiver revoked at the publisher gate", () => {
    const root = tempRoots.make("release-publish-gates-revoked-");
    const manifestPath = join(root, "manifest.json");
    const output = join(root, "output");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        runReleaseSoak: "false",
        controls: { performanceBlocking: true },
        childRuns: { productPerformance: { conclusion: "success" } },
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
          pluginSdkApiAcknowledgement: "",
          stableSoakWaiver: "2026.9.5 approved earlier",
          npmDecisions: [],
        },
      }),
    );
    const run = (currentVariable: string) =>
      spawnSync(
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
            OPENCLAW_RELEASE_STABLE_SOAK_WAIVER: currentVariable,
            GITHUB_OUTPUT: output,
          },
        },
      );
    expect(run("2026.9.5 approved earlier").status).toBe(0);
    const revoked = run("");
    expect(revoked.status).not.toBe(0);
    expect(revoked.stderr).toContain("Stable releases require Full Release Validation");
  });

  it.each(["legacy", "sealed", "whitespace"] as const)(
    "resolves escaped workflow outputs without installed dependencies (sealed=%s)",
    (mode) => {
      const sealed = mode !== "legacy";
      const root = tempRoots.make("release-publish-gates-");
      const manifestPath = join(root, "manifest.json");
      const output = join(root, "output");
      const summary = join(root, "summary");
      const waiver = '2026.9.5 Infrastructure 100% unavailable\nOperator "approved"';
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          runReleaseSoak: "false",
          controls: { performanceBlocking: false },
          ...(sealed
            ? {
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
                  stableSoakWaiver: waiver,
                  npmDecisions: [],
                },
              }
            : {}),
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
            ...(mode === "whitespace"
              ? { STABLE_SOAK_WAIVER: " \n\t", PLUGIN_SDK_API_ACKNOWLEDGEMENT: " \n\t" }
              : sealed
                ? {}
                : { STABLE_SOAK_WAIVER: waiver }),
            ...(sealed ? { OPENCLAW_RELEASE_STABLE_SOAK_WAIVER: waiver } : {}),
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        '2026.9.5 Infrastructure 100%25 unavailable%0AOperator "approved"',
      );
      expect(readFileSync(output, "utf8").split("\n")).toEqual([
        `stable_soak_waiver=${JSON.stringify(waiver)}`,
        `plugin_sdk_api_acknowledgement=${sealed ? "aaaaaaaa" : ""}`,
        "npm_decisions=[]",
        "release_profile=stable",
        "coverage_policy=full",
        "",
      ]);
      expect(readFileSync(summary, "utf8")).toBe(`- Stable soak waived by operator: ${waiver}\n`);
    },
  );
});

describe("strict default and operator fast path", () => {
  const stableGates = (input: {
    manifest: unknown;
    stableSoakWaiver?: string;
    laneWaiver?: string;
    releaseTag?: string;
  }) =>
    evaluateReleasePublishGates({
      consumer: "publisher",
      releaseTag: "v2026.9.6",
      npmDistTag: "latest",
      expectedSha: targetSha,
      ...input,
    });
  const byId = (gates: ReturnType<typeof evaluateReleasePublishGates>, id: string) =>
    gates.find((entry) => entry.id === `publisher.${id}`);
  const betaEvidence = {
    ...manifest,
    releaseProfile: "beta",
    runReleaseSoak: "false",
    controls: { performanceBlocking: false },
  };

  it("fails closed for a stable tag published from beta evidence without waivers", () => {
    const gates = stableGates({ manifest: betaEvidence });
    expect(byId(gates, "stable-profile")).toMatchObject({ status: "FAIL" });
    expect(byId(gates, "soak")).toMatchObject({ status: "FAIL" });
    expect(byId(gates, "performance")).toMatchObject({ status: "FAIL" });
  });

  it("warns instead of failing when the operator supplies a version-bound soak waiver", () => {
    const gates = stableGates({
      manifest: { ...betaEvidence, childRuns: { productPerformance: { conclusion: "success" } } },
      stableSoakWaiver: "2026.9.6 ship the hotfix",
    });
    expect(byId(gates, "waiver-target")).toBeUndefined();
    expect(byId(gates, "stable-profile")).toMatchObject({ status: "WARN" });
    expect(byId(gates, "soak")).toMatchObject({ status: "WARN" });
  });

  it("rejects waiver reasons that do not name the target version", () => {
    const gates = stableGates({ manifest: betaEvidence, stableSoakWaiver: "ship it" });
    expect(byId(gates, "waiver-target")).toMatchObject({ status: "FAIL" });
    expect(
      byId(stableGates({ manifest: betaEvidence, laneWaiver: "2026.9.7 other" }), "waiver-target"),
    ).toMatchObject({ status: "FAIL" });
  });

  it.each(["stableSoakWaiver", "laneWaiver"] as const)(
    "accepts only the matching publish-accepted %s at closeout",
    (key) => {
      for (const consumer of ["stable-closeout", "publisher", "core-npm"] as const) {
        for (const accepted of ["ship it", " \nship it\t", "2026.9.6 something else"]) {
          const gates = evaluateReleasePublishGates({
            consumer,
            manifest: betaEvidence,
            releaseTag: "v2026.9.6",
            npmDistTag: "latest",
            stableSoakWaiver: "2026.9.6 soak waived",
            [key]: " ship it ",
            publishAcceptedWaivers: { [key]: accepted },
          });
          const targetGate = gates.find((gate) => gate.id === `${consumer}.waiver-target`);
          if (consumer === "stable-closeout" && accepted.trim() === "ship it") {
            expect(targetGate).toBeUndefined();
            expect(gates.filter((gate) => gate.status === "FAIL")).toEqual([]);
          } else {
            expect(targetGate).toMatchObject({ status: "FAIL" });
          }
        }
      }
    },
  );

  it.each([
    { consumer: "stable-closeout", published: true, exitCode: 0 },
    { consumer: "stable-closeout", published: false, exitCode: 1 },
    { consumer: "publisher", published: true, exitCode: 1 },
    { consumer: "core-npm", published: true, exitCode: 1 },
  ])(
    "scopes published waiver environment inputs to $consumer (published=$published)",
    ({ consumer, published, exitCode }) => {
      const root = tempRoots.make("release-publish-gates-accepted-");
      const manifestPath = join(root, "manifest.json");
      const waiver = "Operator-approved by Peter for 2026.9.6: soak-only";
      writeFileSync(manifestPath, JSON.stringify(betaEvidence));
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/lib/release-publish-gates.mts"),
          "--consumer",
          consumer,
          "--manifest",
          manifestPath,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            RELEASE_TAG: "v2026.9.6",
            RELEASE_NPM_DIST_TAG: "latest",
            EXPECTED_SHA: targetSha,
            EXPECTED_RELEASE_PROFILE: "from-validation",
            STABLE_SOAK_WAIVER: waiver,
            ...(published ? { PUBLISHED_STABLE_SOAK_WAIVER: waiver } : {}),
          },
        },
      );
      expect(result.status, result.stderr).toBe(exitCode);
      if (exitCode === 0) {
        expect(result.stdout).toContain("::warning::");
      } else {
        expect(result.stderr).toContain(
          "Waiver reasons must start with the target version 2026.9.6",
        );
      }
    },
  );

  it("requires lane_waiver to publish a stable with a failed non-proof lane", () => {
    const withFailure = {
      ...manifest,
      advisoryJobs: [
        {
          child: "normalCi",
          job: "checks-windows-node-test-1",
          status: "completed",
          conclusion: "failure",
          policy: "advisory",
        },
      ],
    };
    expect(byId(stableGates({ manifest: withFailure }), "lane-waiver")).toMatchObject({
      status: "FAIL",
    });
    expect(
      byId(
        stableGates({ manifest: withFailure, laneWaiver: "2026.9.6 known flake" }),
        "lane-waiver",
      ),
    ).toMatchObject({
      status: "WARN",
      message:
        "Operator lane waiver: 2026.9.6 known flake; waived lanes (1): normalCi checks-windows-node-test-1",
    });
    expect(
      byId(stableGates({ manifest: withFailure, releaseTag: "v2026.9.6-beta.1" }), "lane-waiver"),
    ).toBeUndefined();
  });
});

describe("stable closeout of a soak-waived stable", () => {
  const waivedStable = {
    ...manifest,
    releaseProfile: "beta",
    runReleaseSoak: false,
    controls: { performanceBlocking: false },
    childRuns: { productPerformance: { conclusion: "success" } },
  };
  const closeout = (stableSoakWaiver?: string) =>
    evaluateReleasePublishGates({
      consumer: "stable-closeout",
      releaseTag: "v2026.9.6",
      npmDistTag: "latest",
      expectedSha: targetSha,
      manifest: waivedStable,
      stableSoakWaiver,
    });

  it("passes with the acknowledged waiver and fails without it", () => {
    const waived = closeout("2026.9.6 operator approved");
    expect(waived.filter((gate) => gate.status === "FAIL")).toEqual([]);
    expect(waived.filter((gate) => gate.status === "WARN").map((gate) => gate.id)).toEqual([
      "stable-closeout.performance",
      "stable-closeout.stable-profile",
      "stable-closeout.soak",
    ]);
    expect(
      closeout()
        .filter((gate) => gate.status === "FAIL")
        .map((gate) => gate.id),
    ).toEqual([
      "stable-closeout.performance",
      "stable-closeout.stable-profile",
      "stable-closeout.soak",
    ]);
  });
});

describe("operator lane waiver acknowledgement", () => {
  const waived = {
    ...manifest,
    validationInputs: { coveragePolicy: "full", laneWaiver: "ship 2026.9.6" },
    advisoryJobs: [
      {
        child: "normalCi",
        job: "checks-node-bundle-infra-small-runtime-2",
        conclusion: "failure",
        policy: "advisory",
        reason: "lane_waiver",
      },
      {
        child: "releaseChecksCandidate",
        job: "cross_os_release_checks / Windows / packaged upgrade",
        conclusion: "failure",
        policy: "advisory",
      },
    ],
  };
  const gate = (input: { manifest: unknown; laneWaiver?: string }) =>
    evaluateReleasePublishGates({
      consumer: "publisher",
      releaseTag: "v2026.9.6",
      npmDistTag: "latest",
      expectedSha: targetSha,
      ...input,
    }).find((entry) => entry.id === "publisher.lane-waiver");

  it("blocks waived evidence until the operator acknowledges it", () => {
    expect(gate({ manifest: waived })).toMatchObject({ status: "FAIL" });
    expect(gate({ manifest: waived, laneWaiver: " " })).toMatchObject({ status: "FAIL" });
    expect(gate({ manifest: waived, laneWaiver: "2026.9.6 ack" })).toMatchObject({
      status: "WARN",
      message:
        "Operator lane waiver: 2026.9.6 ack; waived lanes (2): normalCi checks-node-bundle-infra-small-runtime-2, releaseChecksCandidate cross_os_release_checks / Windows / packaged upgrade",
    });
  });

  it("ignores the acknowledgement when evidence carries no waiver", () => {
    expect(gate({ manifest, laneWaiver: "2026.9.6 ack" })).toBeUndefined();
  });
});
