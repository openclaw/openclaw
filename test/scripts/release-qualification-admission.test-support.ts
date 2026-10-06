import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
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

// A single stored ZIP exercises the actual bounded archive consumer without I/O.
function zip(bytes: Buffer) {
  const name = Buffer.from(QUALIFICATION_ADMISSION_FILE);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(bytes), 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + bytes.length, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

export function request(
  overrides: Record<string, string | number | boolean> = {},
  selectedSha = candidateSha,
) {
  return buildQualificationAdmissionRequest({
    repository,
    candidateSha: selectedSha,
    qualificationSha: selectedSha,
    requestId,
    transportRef: "release-ci/" + selectedSha.slice(0, 12) + "-123",
    reviewed: true,
    inputs: {
      ref: candidateSha,
      expected_sha: candidateSha,
      release_profile: "beta",
      rerun_group: "all",
      mode: "both",
      plugin_prerelease_node_exclude_patterns_json: "[]",
      skip_package_telegram_e2e: "false",
      codex_plugin_spec: "",
      trusted_workflow_json: JSON.stringify({
        trustedWorkflow: {
          ref: transportRef,
          fullRef: "refs/heads/" + transportRef,
          sha: candidateSha,
        },
        validationPurpose: "publish",
        publicationSelection: { npmDistTag: "beta" },
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
    policy?: unknown;
    workflowSource?: string;
    candidateSha?: string;
    candidateVersion?: string;
    oldestSupportedBaseline?: string | null;
  } = {},
) {
  const selected = request(options.inputs, options.candidateSha);
  const sourceSha = selected.candidateSha;
  const ref = protectedTag ? "release-publish/bbbbbbbbbbbb-10" : "main";
  const producer = {
    repository,
    runId: 40,
    runAttempt: 1,
    workflowPath: QUALIFICATION_ADMISSION_WORKFLOW,
    workflowEvent: "workflow_dispatch",
    workflowHeadBranch: ref,
    workflowFullRef: protectedTag ? "refs/tags/" + ref : "refs/heads/main",
    workflowSha: publisherSha,
  };
  const actor = { id: 91, login: "release-operator", type: "User" };
  const run = {
    id: 40,
    run_attempt: 1,
    path: producer.workflowPath,
    event: "workflow_dispatch",
    head_sha: publisherSha,
    head_branch: ref,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: "in_progress",
    conclusion: null as string | null,
    display_title: "Qualification Admission " + requestId,
    actor,
    triggering_actor: { ...actor },
  };
  const authority = { permission: "write", ancestry: "ahead", tagSha: publisherSha };
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
  const sources = new Map([
    [
      publisherSha + ":" + QUALIFICATION_ADMISSION_WORKFLOW,
      'env:\n  RELEASE_QUALIFICATION_ADMISSION_CONTRACT: "1"\njobs:\n  admit_qualification:\n',
    ],
    [
      sourceSha + ":" + QUALIFICATION_WORKFLOW,
      options.workflowSource ??
        "on:\n  workflow_dispatch:\n    inputs:\n" +
          Object.keys(selected.inputs)
            .map((key) => "      " + key + ":\n        type: string\n")
            .join("") +
          "jobs:\n  untrusted:\n    run: NEVER_EXECUTE_Q\n",
    ],
    [sourceSha + ":scripts/lib/release-qualification-coverage.json", JSON.stringify(policy)],
    [
      sourceSha + ":package.json",
      JSON.stringify({ version: options.candidateVersion ?? "2026.8.1" }),
    ],
    [
      sourceSha + ":scripts/lib/upgrade-survivor-scenarios.json",
      JSON.stringify({
        oldestSupportedBaseline: Object.hasOwn(options, "oldestSupportedBaseline")
          ? options.oldestSupportedBaseline
          : "2026.6.34",
      }),
    ],
  ]);
  const metadata = {
    id: 70,
    name: qualificationAdmissionArtifactName(40, 1),
    digest: "",
    size_in_bytes: 0,
    expired: false,
    created_at: "2026-09-28T00:00:02Z",
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: 40, head_sha: publisherSha },
  };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        id: 60,
        name: QUALIFICATION_ADMISSION_JOB,
        run_id: 40,
        run_attempt: 1,
        head_sha: publisherSha,
        status: "completed",
        conclusion: "success",
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
    if (!endpoint) {
      throw new Error("Unexpected command");
    }
    calls.push(endpoint);
    const prefix = "repos/" + repository + "/";
    if (!endpoint.startsWith(prefix)) {
      throw new Error("Wrong repository");
    }
    const path = endpoint.slice(prefix.length);
    if (path === "compare/" + publisherSha + "...main") {
      return JSON.stringify({ status: authority.ancestry });
    }
    if (path === "git/ref/tags/" + ref) {
      return JSON.stringify({
        ref: producer.workflowFullRef,
        object: { type: "commit", sha: authority.tagSha },
      });
    }
    if (path === "actions/runs/40/attempts/1") {
      return JSON.stringify(run);
    }
    if (path === "collaborators/" + actor.login + "/permission") {
      return JSON.stringify({ permission: authority.permission, user: actor });
    }
    if (path === "actions/artifacts/70") {
      return JSON.stringify(metadata);
    }
    if (path === "actions/runs/40/attempts/1/jobs?per_page=100") {
      return JSON.stringify(jobs);
    }
    if (path.startsWith("actions/runs/40/artifacts?")) {
      return JSON.stringify({ total_count: 1, artifacts: [metadata] });
    }
    if (path.startsWith("contents/")) {
      const [sourcePath, sha] = path.slice(9).split("?ref=");
      const text = sources.get(sha + ":" + sourcePath);
      if (text === undefined) {
        throw new Error("Unexpected source acquisition: " + path);
      }
      const bytes = Buffer.from(text);
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
  let archive = zip(Buffer.from(JSON.stringify(receipt)));
  const seal = () => {
    archive = zip(Buffer.from(JSON.stringify(receipt)));
    metadata.digest = digest(archive);
    metadata.size_in_bytes = archive.length;
  };
  seal();
  run.status = "completed";
  run.conclusion = "success";
  const descriptor = {
    ...producer,
    artifactId: metadata.id,
    artifactName: metadata.name,
    artifactDigest: metadata.digest,
    artifactSizeBytes: metadata.size_in_bytes,
  };
  const verify = (inputs = selected.inputs, downloadArchive = () => archive) =>
    verifyQualificationAdmission({
      descriptor,
      repository,
      candidateSha: sourceSha,
      qualificationSha: sourceSha,
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
    seal,
    archive: () => archive,
  };
}
