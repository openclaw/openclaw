import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { preparedDockerEvidenceFromFullRelease } from "../../scripts/docker-release-artifacts.mjs";
import { validateFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import { releaseExecutionPlanSha256 } from "../../scripts/full-release-validation-policy.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  validateReleaseRunEvidence,
  runReleaseRecoveryCli,
} from "../../scripts/release-ci-summary.mjs";
import { verifyReleaseRecoveryProducer } from "../../scripts/release-qualification-admission.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture() {
  const origin = candidatePublicationFixture({ runId: "500" });
  const f = candidatePublicationFixture({
    publicationArtifactSource: { runId: "500", runAttempt: 1 },
  });
  Object.assign(f.plan, {
    candidate: origin.plan.candidate,
    publicationArtifactSource: origin.source,
  });
  f.plan.sha256 = releaseExecutionPlanSha256(f.plan);
  const producer = { ...f.admission.producer, runId: 991, runAttempt: 1 };
  const run = {
    ...f.admission.run,
    status: "in_progress",
    conclusion: null as string | null,
    id: 991,
    head_sha: f.p,
    head_branch: producer.workflowHeadBranch,
    path: producer.workflowPath,
    html_url: "https://github.com/openclaw/openclaw/actions/runs/991",
  };
  const originalArtifact = f.client.loadManifest().artifact;
  const artifact = {
    ...originalArtifact,
    id: 992,
    name: "full-release-validation-991-1",
    workflow_run: { id: 991, head_sha: f.p, head_branch: producer.workflowHeadBranch },
  };
  const rerun = vi.fn(() => {
    throw new Error("recovery must not dispatch");
  });
  let sealed: unknown;
  const client = {
    ...f.client,
    getRun: async (id: string) => (id === "991" ? run : f.client.getRun(id)),
    loadManifest: vi.fn((id: string) => {
      if (id !== "991") {
        throw new Error("original manifest is absent");
      }
      return { manifest: sealed, artifact };
    }),
    loadExecutionPlanEvidence: () => ({
      ...f.client.loadExecutionPlanEvidence(),
      artifact: {
        ...f.client.loadExecutionPlanEvidence().artifact,
        id: 900,
        name: "full-release-execution-plan-" + f.runId,
        digest: "sha256:" + "1".repeat(64),
        size_in_bytes: 100,
      },
    }),
    selectPublicationArtifactSource: vi.fn(async () => ({
      source: origin.source,
      candidate: validateFullReleaseCandidateBinding(origin.plan.candidate),
      outputs: {},
      publicationArtifacts: { ...origin.manifest.publicationArtifacts, pluginNpm: null },
    })),
    verifyReleaseRecoveryProducer: vi.fn((options) =>
      verifyReleaseRecoveryProducer({
        ...options,
        runGh: (args: string[]) => {
          const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
          if (
            endpoint.endsWith("actions/runs/991") ||
            endpoint.endsWith("actions/runs/991/attempts/1")
          ) {
            return JSON.stringify(run);
          }
          if (endpoint.endsWith("actions/runs/991/attempts/1/jobs?per_page=100")) {
            return JSON.stringify({
              total_count: 1,
              jobs: [
                {
                  name: "Seal retained qualification",
                  run_id: 991,
                  run_attempt: 1,
                  status: run.status,
                  conclusion: run.conclusion,
                  steps: [
                    "Checkout authenticated P recovery owner",
                    "Verify and seal original qualification",
                    "Upload immutable recovery aggregate",
                  ].map((name) => ({ name, status: "completed", conclusion: "success" })),
                },
              ],
            });
          }
          return f.admission.runGh(args);
        },
      }),
    ),
    rerunParent: rerun,
    dispatch: rerun,
  };
  f.admission.sources.set(
    f.p + ":" + producer.workflowPath,
    readFileSync(producer.workflowPath, "utf8"),
  );
  return {
    f,
    producer,
    run,
    client,
    rerun,
    setSealed: (manifest: unknown) => {
      sealed = manifest;
      run.status = "completed";
      run.conclusion = "success";
    },
  };
}

it("seals the original plan without an original manifest or any new CI/old-parent dispatch", async () => {
  const { f, producer, client, rerun, setSealed } = fixture();
  const { env, manifestPath } = await cliFixture(f, producer, client);
  await runReleaseRecoveryCli(["--seal-recovery"], env, client);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  setSealed(manifest);
  const evidence = await validateReleaseRunEvidence(
    {
      repository: f.repository,
      runId: "991",
      trustedWorkflowRef: producer.workflowHeadBranch,
      trustedWorkflowFullRef: producer.workflowFullRef,
      trustedWorkflowSha: f.p,
      verifierSourceSha: f.p,
      verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
    },
    client,
  );
  expect(evidence.current.runId).toBe("991");
  expect(evidence.current.workflowSha).toBe(f.p);
  expect(evidence.manifest.workflowSha).toBe(f.q);
  expect(evidence.manifest.runId).toBe(f.runId);
  expect(evidence.executionPlan?.sha256).toBe(f.plan.sha256);
  expect(rerun).not.toHaveBeenCalled();
  expect(client.loadManifest).toHaveBeenCalledTimes(1);
  await authenticateFullReleaseValidationEvidence(
    {
      run: await client.getRun("991"),
      manifest,
      expectedRepository: f.repository,
      expectedRunId: "991",
      expectedRunAttempt: 1,
      expectedTargetSha: f.c,
      expectedPublicationSelection: f.source.publicationSelection ?? undefined,
      expectedReleaseTag: "v2026.8.28-beta.1",
      expectedTrustedWorkflowFullRef: producer.workflowFullRef,
      expectedTrustedWorkflowSha: f.p,
      verifierSourceSha: f.p,
      verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
    },
    client,
  );
  expect(
    validateFullReleaseNpmPreflight({
      manifest,
      repository: f.repository,
      runId: "991",
      runAttempt: 1,
      sourceSha: f.c,
      toolingSha: f.q,
    }),
  ).toEqual(manifest.publicationArtifacts.npmPreflight);
  expect(
    preparedDockerEvidenceFromFullRelease({
      manifest,
      sourceSha: f.c,
      runId: "991",
      runAttempt: 1,
    }),
  ).toEqual(manifest.publicationArtifacts.docker);
});

async function cliFixture(
  f: ReturnType<typeof fixture>["f"],
  producer: ReturnType<typeof fixture>["producer"],
  client: ReturnType<typeof fixture>["client"],
) {
  mkdirSync(".openclaw/tmp", { recursive: true });
  const directory = mkdtempSync(".openclaw/tmp/recovery-cli-");
  directories.push(directory);
  const requestPath = join(directory, "request.json");
  await runReleaseRecoveryCli(["--prepare-recovery", f.runId, "--output", requestPath], {}, client);
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  const eventPath = join(directory, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      inputs: { operation: "recover-qualification", recovery_request: JSON.stringify(request) },
    }),
  );
  return {
    request,
    eventPath,
    manifestPath: join(directory, "qualification-recovery/full-release-validation-manifest.json"),
    env: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: f.repository,
      GITHUB_RUN_ID: "991",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF_NAME: producer.workflowHeadBranch,
      GITHUB_REF: producer.workflowFullRef,
      GITHUB_WORKFLOW_SHA: f.p,
      GITHUB_WORKFLOW_REF:
        f.repository + "/" + producer.workflowPath + "@" + producer.workflowFullRef,
      GITHUB_OUTPUT: join(directory, "output"),
      RUNNER_TEMP: directory,
    },
  };
}

it.each(["attempt", "artifact", "input", "transport", "cancelled"])(
  "fails closed through the production CLI on %s drift or failure",
  async (failure) => {
    const { f, producer, client, rerun } = fixture();
    const { env, manifestPath, request, eventPath } = await cliFixture(f, producer, client);
    const child = f.plan.children.find((entry) => entry.selected);
    if (!child) {
      throw new Error("Missing selected fixture child");
    }
    if (failure === "attempt") {
      const getRun = client.getRun;
      client.getRun = async (id) => {
        const run = await getRun(id);
        return id === child.runId ? { ...run, run_attempt: 2 } : run;
      };
    } else if (failure === "artifact") {
      request.sourceArtifact.digest = "sha256:" + "f".repeat(64);
      writeFileSync(
        eventPath,
        JSON.stringify({
          inputs: { operation: "recover-qualification", recovery_request: JSON.stringify(request) },
        }),
      );
    } else if (failure === "input") {
      f.plan.targetSha = "f".repeat(40);
    } else if (failure === "transport") {
      client.getRun = async () => {
        throw new Error("HTTP 502");
      };
    } else {
      const getJobs = client.getRunAttemptJobs;
      client.getRunAttemptJobs = async (id) =>
        (await getJobs(id)).map((job) =>
          id === child.runId ? Object.assign(job, { conclusion: "cancelled" }) : job,
        );
    }
    await expect(runReleaseRecoveryCli(["--seal-recovery"], env, client)).rejects.toThrow();
    expect(existsSync(manifestPath)).toBe(false);
    expect(rerun).not.toHaveBeenCalled();
  },
);

it("wires the protected workflow only to evidence sealing, with read-only permissions", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-release-prepare.yml", "utf8"));
  const job = workflow.jobs.recover_qualification;
  expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
  expect(job.if).toContain("inputs.operation == 'recover-qualification'");
  expect(job.steps[0].with.ref).toBe("${{ github.workflow_sha }}");
  expect(
    job.steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run),
  ).toEqual(["node scripts/release-ci-summary.mjs --seal-recovery"]);
});
