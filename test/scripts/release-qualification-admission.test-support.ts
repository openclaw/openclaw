import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildQualificationAdmissionRequest,
  produceQualificationAdmission,
  qualificationAdmissionArtifactName,
  QUALIFICATION_ADMISSION_FILE,
  QUALIFICATION_ADMISSION_JOB,
  QUALIFICATION_ADMISSION_UPLOAD,
  QUALIFICATION_ADMISSION_WORKFLOW,
  QUALIFICATION_WORKFLOW,
  verifyQualificationAdmission,
} from "../../scripts/release-qualification-admission.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";

export const repository = "openclaw/openclaw";
export const candidateSha = "a".repeat(40);
export const publisherSha = "b".repeat(40);
export const transportRef = "release-ci/aaaaaaaaaaaa-123";
export const qualificationBaselinesJson = JSON.stringify({
  upgradeBaseline: "openclaw@2026.7.9",
  upgradeSurvivorBaselines: ["openclaw@2026.6.34", "openclaw@2026.7.8", "openclaw@2026.7.9"],
});
const requestId = "12345678-1234-1234-1234-123456789abc";
const digest = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

export function request(
  overrides: Record<string, string | number | boolean> = {},
  selectedSha = candidateSha,
  selectedTransportRef = "release-ci/" + selectedSha.slice(0, 12) + "-123",
  qualificationSha = selectedSha,
) {
  return buildQualificationAdmissionRequest({
    repository,
    candidateSha: selectedSha,
    qualificationSha,
    requestId,
    transportRef: selectedTransportRef,
    reviewed: true,
    inputs: {
      ref: candidateSha,
      expected_sha: candidateSha,
      release_profile: "beta",
      rerun_group: "all",
      mode: "both",
      codex_plugin_spec: "",
      trusted_workflow_json: JSON.stringify({
        trustedWorkflow: {
          ref: selectedTransportRef,
          fullRef: "refs/heads/" + selectedTransportRef,
          sha: qualificationSha,
        },
        laneInputs: { qualification_baselines_json: qualificationBaselinesJson },
      }),
      ...overrides,
    },
  });
}

export function fixture(
  protectedTag = false,
  options: {
    inputs?: Record<string, string | number | boolean>;
    missingLedger?: boolean;
    policy?: unknown;
    workflowSource?: string;
    baselinePolicySource?: string;
    candidateSha?: string;
    qualificationSha?: string;
    transportRef?: string;
    candidateVersion?: string;
    oldestSupportedBaseline?: string | null;
    publisherSha?: string;
    selectedRequest?: ReturnType<typeof buildQualificationAdmissionRequest>;
    runId?: number;
  } = {},
) {
  const admissionSha = options.publisherSha ?? publisherSha;
  const runId = options.runId ?? 40;
  const selected =
    options.selectedRequest ??
    request(options.inputs, options.candidateSha, options.transportRef, options.qualificationSha);
  const sourceSha = selected.candidateSha;
  const qualificationSha = selected.qualificationSha;
  const ref = protectedTag ? "release-publish/bbbbbbbbbbbb-10" : "main";
  const producer = {
    repository,
    runId,
    runAttempt: 1,
    workflowPath: QUALIFICATION_ADMISSION_WORKFLOW,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: ref,
    workflowFullRef: protectedTag ? "refs/tags/" + ref : "refs/heads/main",
    workflowSha: admissionSha,
  };
  const actor = { id: 91, login: "release-operator", type: "User" };
  const run = {
    id: runId,
    run_attempt: 1,
    path: producer.workflowPath,
    event: "workflow_dispatch",
    head_sha: admissionSha,
    head_branch: ref,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: "in_progress",
    conclusion: null as string | null,
    display_title: "Qualification Admission " + selected.requestId,
    actor,
    triggering_actor: { ...actor },
  };
  const authority = {
    permission: "write",
    ancestry: "ahead",
    qualificationAncestry: "diverged",
    tagSha: admissionSha,
  };
  const policy = options.policy ?? {
    schema: "openclaw.release-qualification-policy/v1",
    profiles: { beta: ["ci"], stable: ["ci"], full: ["ci"] },
    children: [
      {
        key: "ci",
        workflow: "ci.yml",
        name: "CI",
        parentJobName: "CI",
        dispatchName: "CI",
        suffix: "",
        requiredJobs: ["Gate"],
      },
    ],
    requiredParentJobs: ["Release Decision"],
  };
  const sources = new Map(
    Object.entries({
      [admissionSha + ":" + QUALIFICATION_ADMISSION_WORKFLOW]:
        'env:\n  RELEASE_QUALIFICATION_ADMISSION_CONTRACT: "1"\njobs:\n  admit_qualification:\n',
      [qualificationSha + ":" + QUALIFICATION_WORKFLOW]:
        options.workflowSource ??
        "on:\n  workflow_dispatch:\n    inputs:\n" +
          Object.keys(selected.inputs)
            .map((key) => "      " + key + ":\n        type: string\n")
            .join("") +
          "jobs:\n  untrusted:\n    run: NEVER_EXECUTE_Q\n",
      [qualificationSha + ":scripts/lib/release-validation-waivers.json"]: readFileSync(
        "scripts/lib/release-validation-waivers.json",
        "utf8",
      ),
      [qualificationSha + ":scripts/lib/release-qualification-coverage.json"]:
        JSON.stringify(policy),
      [sourceSha + ":package.json"]: JSON.stringify({
        version: options.candidateVersion ?? "2026.8.1",
      }),
      [sourceSha + ":scripts/lib/upgrade-survivor-scenarios.json"]:
        options.baselinePolicySource ??
        JSON.stringify({
          oldestSupportedBaseline: Object.hasOwn(options, "oldestSupportedBaseline")
            ? options.oldestSupportedBaseline
            : "2026.6.34",
        }),
    }),
  );
  const metadata = {
    id: 70,
    name: qualificationAdmissionArtifactName(runId, 1),
    digest: "",
    size_in_bytes: 0,
    expired: false,
    created_at: "2026-09-28T00:00:02Z",
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: runId, head_sha: admissionSha },
  };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        name: QUALIFICATION_ADMISSION_JOB,
        run_id: runId,
        run_attempt: 1,
        head_sha: admissionSha,
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-28T00:00:00Z",
        completed_at: "2026-09-28T00:00:04Z",
        steps: [
          {
            name: QUALIFICATION_ADMISSION_UPLOAD,
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-28T00:00:01Z",
            completed_at: "2026-09-28T00:00:03Z",
          },
        ],
      },
    ],
  };
  const calls: string[] = [];
  const runGh = (args: string[]) => {
    const endpoint = args.find((arg) => arg.startsWith("repos/"));
    const prefix = "repos/" + repository + "/";
    if (!endpoint?.startsWith(prefix)) {
      throw new Error("Expected API command for " + repository);
    }
    calls.push(endpoint);
    const path = endpoint.slice(prefix.length);
    const routes: Record<string, unknown> = {
      ["compare/" + qualificationSha + "...main"]: { status: authority.qualificationAncestry },
      ["compare/" + admissionSha + "...main"]: { status: authority.ancestry },
      ["git/ref/tags/" + ref]: {
        ref: producer.workflowFullRef,
        object: { type: "commit", sha: authority.tagSha },
      },
      ["actions/runs/" + runId + "/attempts/1"]: run,
      ["collaborators/" + actor.login + "/permission"]: {
        permission: authority.permission,
        user: actor,
      },
      "actions/artifacts/70": metadata,
      ["actions/runs/" + runId + "/attempts/1/jobs?per_page=100"]: jobs,
    };
    if (Object.hasOwn(routes, path)) {
      return JSON.stringify(routes[path]);
    }
    if (path.startsWith("actions/runs/" + runId + "/artifacts?")) {
      return JSON.stringify({ total_count: 1, artifacts: [metadata] });
    }
    if (path.startsWith("contents/")) {
      const [sourcePath, sha] = path.slice(9).split("?ref=");
      const text = sources.get(sha + ":" + sourcePath);
      if (options.missingLedger && sourcePath === "scripts/lib/release-validation-waivers.json") {
        throw new Error("gh: Not Found (HTTP 404)");
      }
      const source = text;
      if (source === undefined) {
        throw new Error("Unexpected source acquisition: " + path);
      }
      const bytes = Buffer.from(source);
      return JSON.stringify({
        type: "file",
        path: sourcePath,
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
        sha: createHash("sha1")
          .update("blob " + bytes.length + "\0")
          .update(bytes)
          .digest("hex"),
      });
    }
    throw new Error("Unexpected API: " + path);
  };
  const receipt = produceQualificationAdmission({ request: selected, producer, runGh });
  const archive = makeStoredZip({ [QUALIFICATION_ADMISSION_FILE]: JSON.stringify(receipt) });
  metadata.digest = digest(archive);
  metadata.size_in_bytes = archive.length;
  run.status = "completed";
  run.conclusion = "success";
  const descriptor = {
    ...producer,
    artifactId: metadata.id,
    artifactName: metadata.name,
    artifactDigest: metadata.digest,
    artifactSizeBytes: metadata.size_in_bytes,
  };
  const verify = (inputs = selected.inputs, downloadArchive: () => Uint8Array = () => archive) =>
    verifyQualificationAdmission({
      descriptor,
      repository,
      candidateSha: sourceSha,
      qualificationSha,
      workflowRef: selected.transportRef,
      inputs,
      runGh,
      downloadArchive,
    });
  return {
    selected,
    producer,
    actor,
    run,
    authority,
    sources,
    metadata,
    jobs,
    calls,
    runGh,
    receipt,
    descriptor,
    verify,
    archive: () => archive,
  };
}
