import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateReleaseBootstrapGate,
  evaluateReleasePublishGates,
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

type HistoricalInput = Partial<GateInput> & {
  stableSoakWaiver?: string;
  laneWaiver?: string;
  publishAcceptedWaivers?: Record<string, string>;
};
type Outcome = string[] | "any failure" | "selected-lanes";
type PolicyRow = [string, Evidence, Outcome, HistoricalInput?];
const consumers = ["publisher", "core-npm", "stable-closeout"] as const;
const waiver = "2026.9.5 approved";
type SharedCase = { changes: Evidence; expected: string[]; input: HistoricalInput };
describe.each(consumers)("%s publication gates", (consumer) => {
  it.each`
    name                     | changes                                                                                          | expected                                     | input
    ${"stable evidence"}     | ${{}}                                                                                            | ${[]}                                        | ${{ expectedSha: targetSha }}
    ${"waived soak"}         | ${{ controls: { performanceBlocking: false }, runReleaseSoak: "false" }}                         | ${["performance", "soak"]}                   | ${{ expectedSha: targetSha, stableSoakWaiver: "2026.9.5 Approved after infrastructure failure" }}
    ${"missing performance"} | ${{ controls: {}, childRuns: {} }}                                                               | ${["performance"]}                           | ${{ expectedSha: targetSha }}
    ${"historical waivers"}  | ${{ releaseProfile: "beta", runReleaseSoak: "false", controls: { performanceBlocking: false } }} | ${["performance", "stable-profile", "soak"]} | ${{ stableSoakWaiver: waiver, laneWaiver: waiver, publishAcceptedWaivers: { stableSoakWaiver: waiver, laneWaiver: waiver } }}
  `("$name", ({ changes, expected, input }: SharedCase) =>
    checkPolicy(changes, expected, { ...input, consumer }),
  );
});
const recordedWaivers = [
  { validationInputs: { laneWaiver: waiver } },
  { publishInputs: { stableSoakWaiver: waiver } },
  { validationInputs: { knownFlakyJobsJson: '["checks-windows-node-test-2"]' } },
  { advisoryJobs: [{ child: "normalCi", job: "tests", conclusion: "failure" }] },
];
const policyCases: PolicyRow[] = [
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
  ...recordedWaivers.flatMap((changes, index) =>
    ["v2026.9.5", "v2026.9.5-beta.1"].map((releaseTag): PolicyRow => [
      `recorded waiver/advisory ${index}/${releaseTag}`,
      changes,
      "selected-lanes",
      { releaseTag, npmDistTag: releaseTag.includes("beta") ? "beta" : "latest" },
    ]),
  ),
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
function checkPolicy(changes: Evidence, expected: Outcome, input?: HistoricalInput) {
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
