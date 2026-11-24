import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { releaseManifestChildEvidence } from "../../scripts/lib/full-release-manifest.mjs";
import {
  evaluateReleaseBootstrapGate,
  evaluateReleasePublishGates,
  evaluateStableRollbackDrill,
} from "../../scripts/lib/release-publish-gates.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { expectGate } from "./release-publish.test-support.js";

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
type GateInput = Parameters<typeof evaluateReleasePublishGates>[0];
type Evidence = Record<string, unknown>;
function evaluate(changes: Evidence = {}, input: Partial<GateInput> = {}) {
  return evaluateReleasePublishGates({
    manifest: { ...manifest, ...changes },
    releaseTag: "v2026.9.5",
    npmDistTag: "latest",
    consumer: "publisher",
    ...input,
  });
}
const failureIds = (gates: ReturnType<typeof evaluate>) =>
  gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id);
it.each([
  { releaseTag: "v2026.9.5-alpha.1", npmDistTag: "beta" },
  { releaseTag: "v2026.9.5", npmDistTag: "alpha" },
])("rejects retired alpha gate input %j", (input) => {
  expectGate(evaluate({}, input), {
    status: "FAIL",
    message: "Alpha releases are retired; use a beta prerelease instead.",
  });
});

type Outcome = string[] | "any failure" | "selected-lanes";
type PolicyRow = [string, Evidence, Outcome, Partial<GateInput>?];
const consumers = ["publisher", "core-npm", "stable-closeout"] as const;
it.each(consumers)("accepts stable evidence for %s", (consumer) => {
  checkPolicy({}, [], { expectedSha: targetSha, consumer });
});
const recordedAdvisories = [
  { validationInputs: { knownFlakyJobsJson: '["checks-windows-node-test-2"]' } },
  { advisoryJobs: [{ child: "normalCi", job: "tests", conclusion: "failure" }] },
];
const policyCases: PolicyRow[] = [
  ["missing performance", { controls: {}, childRuns: {} }, ["performance"]],
  ...(["publisher", "core-npm"] as const).map((consumer): PolicyRow => [
    "deferred beta performance/" + consumer,
    { releaseProfile: "beta", controls: { performanceBlocking: false }, childRuns: {} },
    [],
    { consumer, releaseTag: "v2026.9.5-beta.1", npmDistTag: "beta" },
  ]),
  ["boolean soak accepted by publisher", { runReleaseSoak: true }, []],
  [
    "boolean soak rejected by strict closeout",
    { runReleaseSoak: true },
    "any failure",
    { consumer: "stable-closeout" },
  ],
  [
    "independent identity and policy failures",
    {
      workflowName: "Other",
      targetSha: "b".repeat(40),
      rerunGroup: "performance",
      runReleaseSoak: "false",
    },
    ["workflow", "target", "profile", "rerun-group", "soak"],
    { expectedSha: targetSha, expectedReleaseProfile: "full" },
  ],
  ...recordedAdvisories.map((changes, index): PolicyRow => [
    `recorded advisory ${index}`,
    changes,
    "selected-lanes",
  ]),
  [
    "failed Windows child without advisory row",
    {
      childEvidence: {
        normalCi: {
          runId: "42",
          jobs: [
            { name: "checks-windows-node-test-2", status: "completed", conclusion: "failure" },
          ],
        },
      },
      advisoryJobs: [],
    },
    "selected-lanes",
  ],
];
function checkPolicy(changes: Evidence, expected: Outcome, input?: Partial<GateInput>) {
  const gates = evaluate(changes, input);
  if (typeof expected === "string") {
    expectGate(gates, {
      status: "FAIL",
      ...(expected === "selected-lanes" ? { id: "publisher.selected-lanes" } : {}),
    });
  } else {
    expect(failureIds(gates)).toEqual(
      expected.map((id) => `${input?.consumer ?? "publisher"}.${id}`),
    );
  }
}
it.each(policyCases)("%s", (_name, changes, expected, input) =>
  checkPolicy(changes, expected, input),
);

it("rejects bootstrap approval for another package version", () => {
  const gate = evaluateReleaseBootstrapGate({
    releaseTag: "v2026.9.5",
    publishTag: "latest",
    releaseProfile: "stable",
    packageVersion: "2026.9.4",
  });
  expect(gate.status).toBe("FAIL");
});

it("warns before rollback drill evidence reaches the 90-day limit", () => {
  const gates = evaluateStableRollbackDrill({
    rollbackDrillId: "rollback-drill-2026-q2",
    rollbackDrillDate: "2026-06-01",
    nowMs: Date.parse("2026-08-18T00:00:00Z"),
  });

  expect(gates).toContainEqual({
    id: "stable-closeout.rollback-drill-date",
    status: "WARN",
    message:
      "Rollback drill expires on 2026-08-30; run the private rollback drill before stable closeout.",
    remediation:
      "Run the private rollback drill and record its UTC date in RELEASE_ROLLBACK_DRILL_DATE or supply rollback_drill_date to stable closeout.",
  });
});

it("does not warn while rollback drill evidence has at least 14 days remaining", () => {
  const gates = evaluateStableRollbackDrill({
    rollbackDrillId: "rollback-drill-2026-q2",
    rollbackDrillDate: "2026-06-01",
    nowMs: Date.parse("2026-08-16T00:00:00Z"),
  });

  expect(gates.find((gate) => gate.id === "stable-closeout.rollback-drill-date")?.status).toBe(
    "PASS",
  );
});

it("runs without installed dependencies", () => {
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
      },
    }),
  );
  const script = resolve("scripts/lib/release-publish-gates.mts");
  const result = spawnSync(
    process.execPath,
    [script, "--consumer", "publisher", "--manifest", manifestPath],
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
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(output, "utf8").split("\n")).toEqual([
    "plugin_sdk_api_acknowledgement=aaaaaaaa",
    "npm_decisions=[]",
    "release_profile=stable",
    "coverage_policy=full",
    "",
  ]);
});

it("uses exact Q-only grants through publisher, core-npm and release-note CLIs", () => {
  const root = tempRoots.make("release-q-policy-");
  const q = "b".repeat(40);
  const manifestPath = join(root, "manifest.json");
  const responsePath = join(root, "response.json");
  const gh = join(root, "gh");
  const changelog = join(root, "CHANGELOG.md");
  writeFileSync(changelog, "## 2099.1.1\n\n- Synthetic regression fixture.\n");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require('node:fs');
const expected = ['api', 'repos/openclaw/openclaw/contents/scripts/lib/release-validation-waivers.json?ref=${q}'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(2);
process.stdout.write(fs.readFileSync(${JSON.stringify(responsePath)}, 'utf8'));
`,
  );
  chmodSync(gh, 0o755);
  const grant = {
    targetVersion: "2099.1.1",
    childRole: "normalCi",
    jobName: "synthetic Q-only leaf",
    reason: "Synthetic regression fixture",
    step: "Synthetic failing step",
  };
  const writePolicy = (waivers: (typeof grant)[], corrupt = false) => {
    const bytes = Buffer.from(
      JSON.stringify({ schema: "openclaw.release-validation-waivers/v1", waivers }),
    );
    writeFileSync(
      responsePath,
      JSON.stringify({
        path: "scripts/lib/release-validation-waivers.json",
        type: "file",
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
        sha: corrupt
          ? "0".repeat(40)
          : createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
      }),
    );
  };
  const failedJob = {
    name: grant.jobName,
    status: "completed",
    conclusion: "failure",
    firstIncompleteStep: grant.step,
  };
  const currentManifest = {
    ...manifest,
    workflowSha: q,
    sourceAdmission: {
      qualificationAdmission: {},
      validationPurpose: "publish",
      publicationSelection: { npmDistTag: "latest" },
      projection: { packages: [] },
    },
    validationInputs: { coveragePolicy: "full", targetVersion: grant.targetVersion },
    childEvidence: {
      normalCi: releaseManifestChildEvidence({
        runId: "42",
        runAttempt: 2,
        plannedRunAttempt: 1,
        observedRunAttempts: [1, 2],
        timing: { jobs: [failedJob] },
      }),
    },
    advisoryJobs: [],
    publishInputs: {
      version: 1,
      targetSha,
      npmDistTag: "latest",
      pluginSdkApiEvidenceDigest: "a".repeat(64),
      pluginSdkApiAcknowledgement: "aaaaaaaa",
      npmDecisions: [],
    },
  };
  writeFileSync(manifestPath, JSON.stringify(currentManifest));
  const commands = [
    ...["publisher", "core-npm"].map((consumer) => [
      resolve("scripts/lib/release-publish-gates.mts"),
      "--consumer",
      consumer,
      "--manifest",
      manifestPath,
    ]),
    [
      resolve("scripts/render-github-release-notes.mts"),
      "--changelog",
      changelog,
      "--tag",
      "v2099.1.1",
      "--repository",
      "openclaw/openclaw",
      "--validation-manifest",
      manifestPath,
    ],
  ];
  const run = (args: string[]) =>
    spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: root + delimiter + process.env.PATH,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        OPENCLAW_GH_BIN: undefined,
        RELEASE_TAG: "v2099.1.1",
        RELEASE_NPM_DIST_TAG: "latest",
        OPENCLAW_RELEASE_WAIVERS_PATH: undefined,
      },
    });
  for (const args of commands) {
    writePolicy([grant]);
    const accepted = run(args);
    expect(accepted.status, accepted.stderr).toBe(0);
    writePolicy([{ ...grant, step: "Wrong step" }]);
    const stale = run(args);
    expect(stale.status, stale.stderr).toBe(1);
    expect(stale.stderr).toContain("failed selected job evidence");
    writePolicy([]);
    const unwaived = run(args);
    expect(unwaived.status, unwaived.stderr).toBe(1);
    expect(unwaived.stderr).toContain("failed selected job evidence");
    writePolicy([grant], true);
    const corrupted = run(args);
    expect(corrupted.status, corrupted.stderr).toBe(1);
    expect(corrupted.stderr).toContain("blob mismatch");
  }
  expect(currentManifest.childEvidence.normalCi.jobs[0]).toEqual(failedJob);
});
