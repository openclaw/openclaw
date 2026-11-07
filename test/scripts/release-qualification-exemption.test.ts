import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { buildReleaseExecutionPlan } from "../../scripts/full-release-validation-policy.mjs";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import { buildReleaseValidationManifest } from "../../scripts/lib/full-release-manifest.mjs";
import { RELEASE_VALIDATION_WAIVERS } from "../../scripts/lib/release-validation-waivers.mjs";
import {
  produceQualificationAdmission,
  QUALIFICATION_ADMISSION_FILE,
  QUALIFICATION_WORKFLOW,
  verifyQualificationAdmission,
} from "../../scripts/release-qualification-admission.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { fixture, repository } from "./release-qualification-admission.test-support.js";

const original = structuredClone(RELEASE_VALIDATION_WAIVERS);
afterEach(() =>
  RELEASE_VALIDATION_WAIVERS.splice(
    0,
    RELEASE_VALIDATION_WAIVERS.length,
    ...structuredClone(original),
  ),
);
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function setup() {
  const baselines = (version: string) =>
    JSON.stringify({
      laneInputs: {
        qualification_baselines_json: JSON.stringify({
          upgradeBaseline: "openclaw@" + version,
          upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@" + version],
        }),
      },
    });
  const f = fixture(false, { inputs: { release_profile: "stable" } });
  f.selected.inputs.trusted_workflow_json = baselines("2026.9.36");
  const grant = RELEASE_VALIDATION_WAIVERS.find((row) => row.targetVersion === "2026.9.37")!;
  const evidence = grant.qualificationExemption!;
  const names = [
    "Resolve target ref",
    "Kova mock provider performance",
    "Verify artifact-only report mode",
  ];
  const jobs = names.map((name, i) => ({
    id: i + 1,
    name,
    run_id: evidence.runId,
    run_attempt: 1,
    head_sha: evidence.targetSha,
    status: "completed",
    conclusion: i === 1 ? "failure" : "success",
    html_url:
      "https://github.com/openclaw/openclaw/actions/runs/" + evidence.runId + "/job/" + (i + 1),
    steps: [] as { name: string; status: string; conclusion: string }[],
  }));
  const payload = {
    schema: "openclaw.full-release-child-evidence/v1",
    repository,
    role: "productPerformance",
    targetSha: evidence.targetSha,
    workflowSha: evidence.targetSha,
    workflowRef: evidence.workflowRef,
    runId: String(evidence.runId),
    effectiveRunAttempt: 1,
    sourceParentRunId: evidence.sourceParentRunId,
    sourceParentAttempt: 1,
    workloadConclusion: "failure",
    inputs: { publish_reports: "false" },
    jobs: jobs.map((job) => ({ name: job.name, conclusion: job.conclusion, url: job.html_url })),
  };
  evidence.receiptSha256 = hash(JSON.stringify(canonicalizeJsonValue(payload)));
  const retained = { ...payload, sha256: evidence.receiptSha256 };
  const archive = makeStoredZip({ "full-release-child-evidence.json": JSON.stringify(retained) });
  evidence.artifactDigest = "sha256:" + hash(archive);
  evidence.artifactSizeBytes = archive.length;
  jobs.push({
    ...jobs[0]!,
    id: 4,
    name: "Seal full release child evidence / Seal child receipt",
    steps: [
      "Checkout trusted child evidence tooling",
      "Seal exact child attempt evidence",
      "Upload sealed child evidence",
    ].map((name) => ({ name, status: "completed", conclusion: "success" })),
  });
  const run = {
    id: evidence.runId,
    run_attempt: 1,
    head_sha: evidence.targetSha,
    head_branch: evidence.workflowRef,
    event: "workflow_dispatch",
    path: ".github/workflows/openclaw-performance.yml",
    status: "completed",
    conclusion: "failure",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
  const metadata = {
    id: evidence.artifactId,
    name:
      "full-release-child-evidence-" +
      evidence.targetSha +
      "-productPerformance-" +
      evidence.runId +
      "-1",
    digest: evidence.artifactDigest,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: evidence.runId, head_sha: evidence.targetSha },
  };
  const routes: Record<string, unknown> = {
    ["actions/runs/" + evidence.runId]: run,
    ["actions/artifacts/" + evidence.artifactId]: metadata,
    ["actions/runs/" + evidence.runId + "/attempts/1/jobs?per_page=100"]: {
      total_count: jobs.length,
      jobs,
    },
    ["actions/runs/" + evidence.sourceParentRunId + "/attempts/1"]: {
      ...run,
      id: Number(evidence.sourceParentRunId),
      path: QUALIFICATION_WORKFLOW,
    },
  };
  const runGh = (args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/"))?.split(repository + "/")[1];
    if (path === "actions/artifacts/" + evidence.artifactId + "/zip") {
      return archive;
    }
    if (path && Object.hasOwn(routes, path)) {
      return JSON.stringify(routes[path]);
    }
    return f.runGh(args);
  };
  f.sources.set(
    f.selected.candidateSha + ":package.json",
    JSON.stringify({ version: "2026.9.37" }),
  );
  f.sources.set(
    f.selected.candidateSha + ":" + QUALIFICATION_WORKFLOW,
    f.sources.get(f.selected.candidateSha + ":" + QUALIFICATION_WORKFLOW)! +
      `
env:
  FULL_RELEASE_QUALIFICATION_EXEMPTION_CONTRACT: "1"
`,
  );
  f.sources.set(
    f.selected.candidateSha + ":scripts/lib/release-qualification-coverage.json",
    readFileSync("scripts/lib/release-qualification-coverage.json", "utf8"),
  );
  const produce = () => {
    f.run.status = "in_progress";
    f.run.conclusion = null;
    try {
      return produceQualificationAdmission({ request: f.selected, producer: f.producer, runGh });
    } finally {
      f.run.status = "completed";
      f.run.conclusion = "success";
    }
  };
  const verify = (receipt: ReturnType<typeof produce>) => {
    const bytes = makeStoredZip({ [QUALIFICATION_ADMISSION_FILE]: JSON.stringify(receipt) });
    f.metadata.digest = "sha256:" + hash(bytes);
    f.metadata.size_in_bytes = bytes.length;
    return verifyQualificationAdmission({
      descriptor: {
        ...f.descriptor,
        artifactDigest: f.metadata.digest,
        artifactSizeBytes: bytes.length,
      },
      repository,
      candidateSha: f.selected.candidateSha,
      qualificationSha: f.selected.qualificationSha,
      workflowRef: f.selected.transportRef,
      inputs: f.selected.inputs,
      runGh,
      downloadArchive: () => bytes,
    });
  };
  return { f, evidence, jobs, run, metadata, routes, produce, verify, baselines };
}

it("admits explicit not-run performance for the new target without reusing old measurements", () => {
  const data = setup();
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
  const data = setup();
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
