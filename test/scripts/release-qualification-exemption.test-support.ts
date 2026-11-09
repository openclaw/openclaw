import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalizeJsonValue } from "../../scripts/lib/canonical-json.mjs";
import { RELEASE_VALIDATION_WAIVERS } from "../../scripts/lib/release-validation-waivers.mjs";
import {
  produceQualificationAdmission,
  QUALIFICATION_ADMISSION_FILE,
  QUALIFICATION_WORKFLOW,
  verifyQualificationAdmission,
} from "../../scripts/release-qualification-admission.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { fixture, repository } from "./release-qualification-admission.test-support.js";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export function qualificationExemptionFixture(options: Parameters<typeof fixture>[1] = {}) {
  const baselines = (version: string) =>
    JSON.stringify({
      laneInputs: {
        qualification_baselines_json: JSON.stringify({
          upgradeBaseline: "openclaw@" + version,
          upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@" + version],
        }),
      },
    });
  const f = fixture(false, {
    ...options,
    candidateVersion: "2026.8.1",
    inputs: {
      ...options.inputs,
      ...(options.inputs?.target_context_ref ? { target_context_ref: "release/2026.8.1" } : {}),
      release_profile: "stable",
    },
  });
  if (options.inputs?.target_context_ref) {
    f.selected.inputs.target_context_ref = String(options.inputs.target_context_ref);
  }
  const envelope = JSON.parse(f.selected.inputs.trusted_workflow_json);
  envelope.laneInputs = JSON.parse(baselines("2026.9.36")).laneInputs;
  f.selected.inputs.trusted_workflow_json = JSON.stringify(envelope);
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
      downloadArchive: (args) => (args[1]?.endsWith("/70/zip") ? bytes : archive),
    });
  };
  return { f, evidence, jobs, run, metadata, routes, produce, verify, baselines, runGh, archive };
}
