import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { buildReleaseExecutionPlan } from "../../scripts/full-release-validation-policy.mjs";
import { buildReleaseValidationManifest } from "../../scripts/lib/full-release-manifest.mjs";
import { RELEASE_VALIDATION_WAIVERS } from "../../scripts/lib/release-validation-waivers.mjs";
import { QUALIFICATION_WORKFLOW } from "../../scripts/release-qualification-admission.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { qualificationExemptionFixture } from "./release-qualification-exemption.test-support.js";

const original = structuredClone(RELEASE_VALIDATION_WAIVERS);
afterEach(() =>
  RELEASE_VALIDATION_WAIVERS.splice(
    0,
    RELEASE_VALIDATION_WAIVERS.length,
    ...structuredClone(original),
  ),
);

it("admits explicit not-run performance for the new target without reusing old measurements", () => {
  const data = qualificationExemptionFixture();
  const admission = data.produce();
  expect(admission.coverage.children.map((child) => child.key)).not.toContain("productPerformance");
  expect(admission.coverage.children.map((child) => child.key)).toEqual([
    "normalCi",
    "pluginPrereleaseIndependent",
    "pluginPrereleaseCandidate",
    "releaseChecksIndependent",
    "releaseChecksCandidate",
  ]);
  expect(admission.coverage.exemptions).toEqual([
    expect.objectContaining({
      targetVersion: "2026.9.37",
      disposition: "waived-not-run",
      supportingEvidence: expect.objectContaining({ targetSha: data.evidence.targetSha }),
    }),
  ]);
  expect(data.verify(admission)).toEqual(admission);
  expect(admission.request.candidateSha).not.toBe(data.evidence.targetSha);
  const children = buildReleaseExecutionPlan({
    parentRunId: "60",
    parentRunAttempt: 1,
    rerunGroup: "all",
    qualificationCoverage: admission.coverage,
  }).children;
  expect(children).toHaveLength(5);
  expect(children.every((child) => child.required && child.selected)).toBe(true);
  const root = candidatePublicationFixture();
  const manifest = buildReleaseValidationManifest({
    reusedManifest: undefined,
    plan: { ...root.plan, qualificationCoverage: admission.coverage },
    drain: undefined,
    context: {
      runId: root.runId,
      runAttempt: "1",
      releaseProfile: "stable",
      workflowRef: root.branch,
      workflowSha: root.q,
      targetRef: root.q,
      validationInputs: {},
    },
  });
  expect(manifest.childRuns.productPerformance).toEqual({
    disposition: "waived-not-run",
    runId: "",
    supportingEvidence: data.evidence,
  });
  expect(manifest.childEvidence.productPerformance).toBeUndefined();
  const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
  expect(workflow.jobs.resolve_target.outputs.performance_exempt).toBe(
    "${{ steps.tooling_identity.outputs.performance_exempt }}",
  );
  expect(workflow.jobs.performance.if).toContain(
    "needs.resolve_target.outputs.performance_exempt != 'true'",
  );
});

it.each([
  "mixed failure",
  "cancelled",
  "missing job",
  "bad upload",
  "wrong source",
  "wrong attempt",
  "tampered archive",
  "missing artifact",
  "unsupported Q",
  "revoked policy",
  "wrong version",
])("rejects %s rather than silently skipping performance", (fault) => {
  const data = qualificationExemptionFixture();
  if (fault === "mixed failure") {
    data.jobs[0]!.conclusion = "failure";
  }
  if (fault === "cancelled") {
    data.run.conclusion = "cancelled";
  }
  if (fault === "missing job") {
    data.jobs.splice(0, 1);
  }
  if (fault === "bad upload") {
    data.jobs.at(-1)!.steps.at(-1)!.conclusion = "failure";
  }
  if (fault === "wrong source") {
    data.run.head_sha = "c".repeat(40);
  }
  if (fault === "wrong attempt") {
    data.run.run_attempt = 2;
  }
  if (fault === "tampered archive") {
    data.evidence.artifactDigest = "sha256:" + "0".repeat(64);
  }
  if (fault === "missing artifact") {
    delete data.routes["actions/artifacts/" + data.evidence.artifactId];
  }
  if (fault === "unsupported Q") {
    data.f.sources.set(
      data.f.selected.candidateSha + ":" + QUALIFICATION_WORKFLOW,
      `on:
  workflow_dispatch:
    inputs:
` +
        Object.keys(data.f.selected.inputs)
          .map(
            (key) =>
              "      " +
              key +
              `:
        type: string
`,
          )
          .join(""),
    );
  }
  if (fault === "wrong version") {
    data.f.selected.inputs.trusted_workflow_json = data.baselines("2026.9.37");
    data.f.sources.set(
      data.f.selected.candidateSha + ":package.json",
      JSON.stringify({ version: "2026.9.38" }),
    );
    expect(data.produce().coverage.exemptions).toBeUndefined();
    return;
  }
  if (fault === "revoked policy") {
    const admission = data.produce();
    delete RELEASE_VALIDATION_WAIVERS.find((row) => row.targetVersion === "2026.9.37")!
      .qualificationExemption;
    expect(() => data.verify(admission)).toThrow(/current release-tooling policy/);
    return;
  }
  expect(() => data.produce()).toThrow();
});
