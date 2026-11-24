import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  preparedDockerEvidenceFromFullRelease,
  verifyDockerReleaseProducer,
} from "../../scripts/docker-release-artifacts.mjs";
import { validateFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import { releaseExecutionPlanSha256 } from "../../scripts/full-release-validation-policy.mjs";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
import type { ReusableReleaseChildSelection } from "../../scripts/lib/full-release-child-reuse.mjs";
import {
  validateFullReleaseNpmPreflight,
  verifyNpmPreflightPublicationLineage,
} from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  acquirePublicationManifest,
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

function fixture(substitute = false, recoveryAttempt = 1) {
  const origin = candidatePublicationFixture({
    runId: "500",
    ...(substitute ? { candidateSha: "c".repeat(40), qualificationSha: "e".repeat(40) } : {}),
  });
  const f = candidatePublicationFixture({
    publicationArtifactSource: { runId: "500", runAttempt: 1 },
    ...(substitute ? { candidateSha: "c".repeat(40), qualificationSha: "d".repeat(40) } : {}),
  });
  Object.assign(f.plan, {
    candidate: origin.plan.candidate,
    publicationArtifactSource: origin.source,
  });
  const normal = origin.plan.children.find((child) => child.key === "normalCi");
  const replacement = f.plan.children.find((child) => child.key === "normalCi");
  if (!normal || !replacement) {
    throw new Error("Missing normal CI fixture child");
  }
  const inputs = releaseChildDispatchInputs(readFileSync(".github/workflows/ci.yml", "utf8"), [
    "-f",
    "target_ref=" + f.c,
    "-f",
    "release_scope=npm-beta",
    "-f",
    "include_android=false",
    "-f",
    "target_context_ref=" + f.plan.sourceAdmission.targetContextRef,
    "-f",
    "qualification_baselines_json=" + f.plan.sourceAdmission.coverage.qualification_baselines_json,
  ]);
  const normalCiSelection: ReusableReleaseChildSelection = {
    role: "normalCi",
    repository: f.repository,
    targetSha: f.c,
    runId: normal.runId,
    runAttempt: 1,
    workflowSha: origin.q,
    workflowRef: origin.branch,
    displayTitle: "CI full-release-validation-" + origin.runId + "-1-ci",
    sourceParentRunId: origin.runId,
    sourceParentAttempt: 1,
    url: "https://github.com/openclaw/openclaw/actions/runs/" + normal.runId,
    receiptSha256: "a".repeat(64),
    inputs: Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== "")),
    artifact: {
      id: "993",
      name: "original-ci-receipt",
      digest: "sha256:" + "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      sizeInBytes: 100,
    },
  };
  if (substitute) {
    replacement.runId = "998";
    replacement.url = "https://github.com/openclaw/openclaw/actions/runs/998";
  }
  f.plan.sha256 = releaseExecutionPlanSha256(f.plan);
  const producer = { ...f.admission.producer, runId: 991, runAttempt: recoveryAttempt };
  const run = {
    ...f.admission.run,
    status: "in_progress",
    conclusion: null as string | null,
    id: 991,
    run_attempt: recoveryAttempt,
    head_sha: f.p,
    head_branch: producer.workflowHeadBranch,
    path: producer.workflowPath,
    html_url: "https://github.com/openclaw/openclaw/actions/runs/991",
  };
  const originalArtifact = f.client.loadManifest().artifact;
  const artifact = {
    ...originalArtifact,
    id: 992,
    name: `full-release-validation-991-${recoveryAttempt}`,
    workflow_run: { id: 991, head_sha: f.p, head_branch: producer.workflowHeadBranch },
  };
  const rerun = vi.fn(() => {
    throw new Error("recovery must not dispatch");
  });
  let sealed: unknown;
  const client = {
    ...f.client,
    getRun: vi.fn(async (id: string) => {
      if (substitute && id === "998") {
        throw new Error("Replacement CI is not a recovery prerequisite");
      }
      return id === "991"
        ? run
        : substitute && [origin.runId, normal.runId].includes(id)
          ? origin.client.getRun(id)
          : f.client.getRun(id);
    }),
    getRunAttempt: (id: string, attempt: number) =>
      substitute && id === origin.runId
        ? origin.client.getRunAttempt(id, attempt)
        : f.client.getRunAttempt(id, attempt),
    getRunAttemptJobs: (id: string) =>
      substitute && [origin.runId, normal.runId].includes(id)
        ? origin.client.getRunAttemptJobs(id)
        : f.client.getRunAttemptJobs(id),
    getParentJobs: (id: string) =>
      substitute && id === origin.runId
        ? origin.client.getParentJobs(id)
        : f.client.getParentJobs(id),
    getJobLog: async (id: number) => {
      const dispatch = (await origin.client.getParentJobs(origin.runId)).find(
        (job: { name: string }) => job.name === "Dispatch CI",
      );
      return substitute && (id === 10902 || id === dispatch?.id)
        ? origin.client.getJobLog(id)
        : f.client.getJobLog(id);
    },
    validateChildReuse: vi.fn(
      async (
        selection: typeof normalCiSelection,
        request: {
          inputs: Record<string, string>;
          workflowSha: string;
          targetSha: string;
          role: string;
        },
      ) => {
        expect(request.workflowSha).toBe(f.q);
        expect(request.targetSha).toBe(f.c);
        expect(request.role).toBe("normalCi");
        expect(
          Object.fromEntries(Object.entries(request.inputs).filter(([, value]) => value !== "")),
        ).toEqual(normalCiSelection.inputs);
        if (JSON.stringify(selection) !== JSON.stringify(normalCiSelection)) {
          throw new Error("Receipt or exact dispatch inputs changed");
        }
        return {
          selection,
          run: await origin.client.getRun(normal.runId),
          receipt: {},
          jobs: [],
          compositeJobs: [],
        };
      },
    ),
    loadManifest: vi.fn((id: string, attempt: number) => {
      if (id !== "991" || attempt !== recoveryAttempt) {
        throw new Error("Only the sealed recovery attempt has a manifest");
      }
      return { manifest: sealed, artifact };
    }),
    loadExecutionPlanEvidence: (id?: string) =>
      substitute && id === origin.runId
        ? origin.client.loadExecutionPlanEvidence()
        : {
            ...f.client.loadExecutionPlanEvidence(),
            artifact: {
              ...f.client.loadExecutionPlanEvidence().artifact,
              id: 900,
              name: "full-release-execution-plan-" + f.runId,
              digest: "sha256:" + "1".repeat(64),
              size_in_bytes: 100,
            },
          },
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
            endpoint.endsWith(`actions/runs/991/attempts/${recoveryAttempt}`)
          ) {
            return JSON.stringify(run);
          }
          if (endpoint.endsWith(`actions/runs/991/attempts/${recoveryAttempt}/jobs?per_page=100`)) {
            return JSON.stringify({
              total_count: 1,
              jobs: [
                {
                  name: "Seal retained qualification",
                  run_id: 991,
                  run_attempt: recoveryAttempt,
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
    origin,
    normalCiSelection,
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

it("authenticates the sealed recovery attempt while npm and Docker keep their original producers", async () => {
  const { f, origin, normalCiSelection, producer, run, client, rerun, setSealed } = fixture(
    true,
    2,
  );
  const { env, manifestPath } = await cliFixture(f, producer, client, normalCiSelection);
  client.getRun.mockClear();
  client.validateChildReuse.mockClear();
  await runReleaseRecoveryCli(["--seal-recovery"], env, client);
  // Sealing observes the original and each child once; the full verifier,
  // which starts by reading producer 991, owns its own fresh reads.
  const runReads = client.getRun.mock.calls.map(([id]) => id);
  const sealReads = runReads.slice(0, runReads.indexOf("991"));
  expect(sealReads).toEqual([...new Set(sealReads)]);
  expect(sealReads).toContain(f.runId);
  expect(client.validateChildReuse).toHaveBeenCalledTimes(3);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  setSealed(manifest);
  expect(manifest).toMatchObject({
    runId: f.runId,
    runAttempt: "1",
    workflowSha: f.q,
    recovery: { producer: { runId: 991, runAttempt: 2, workflowSha: f.p } },
  });
  const publisher = {
    publisherSha: f.p,
    publisherFullRef: producer.workflowFullRef,
    evidenceClient: client,
  };
  const [npm, docker] = await Promise.all([
    verifyNpmPreflightPublicationLineage({
      ...publisher,
      manifest,
      repository: f.repository,
      sourceSha: f.c,
      toolingSha: origin.q,
      producerRunId: origin.runId,
      producerRunAttempt: "1",
    }),
    verifyDockerReleaseProducer(origin.docker, {
      ...publisher,
      fullReleaseManifest: manifest,
      readApi: origin.readApi,
    }),
  ]);
  expect(npm).toEqual(origin.npmQualified);
  expect(docker.manifest).toBe(origin.docker);
  docker.revalidateAuthority();
  expect(client.loadManifest.mock.calls.map(([id, attempt]) => [id, attempt])).toEqual([
    ["991", 2],
    ["991", 2],
  ]);
  const closeout = parse(
    readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8"),
  );
  const step = closeout.jobs.verify.steps.find(
    (entry: { name: string }) => entry.name === "Verify release workflow evidence",
  );
  const closeoutGate = step.run.match(
    /node --input-type=module - "\$RUNNER_TEMP\/full-release-validation-run.json"[^\n]* <<'NODE'\n([\s\S]*?)\nNODE/u,
  )?.[1];
  if (!closeoutGate) {
    throw new Error("Missing closeout workflow evidence gate");
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const verify = new AsyncFunction(
    "readFileSync",
    "validateReleaseRunEvidence",
    "createReleaseEvidenceClient",
    "process",
    closeoutGate.replace(/^import .*?;$/gmu, ""),
  );
  const qualifyCloseout = async (attempt: string, sourceSha = f.c) =>
    verify(
      (path: string) =>
        JSON.stringify(
          path === "run"
            ? {
                ...run,
                name: "OpenClaw Release Prepare",
              }
            : manifest,
        ),
      (options: Parameters<typeof validateReleaseRunEvidence>[0]) =>
        validateReleaseRunEvidence(
          {
            ...options,
            verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
          },
          client,
        ),
      () => client,
      {
        argv: ["node", "-", "run", "manifest"],
        env: {
          GITHUB_REPOSITORY: f.repository,
          FULL_RELEASE_VALIDATION_RUN_ID: "991",
          FULL_RELEASE_VALIDATION_RUN_ATTEMPT: attempt,
          SOURCE_SHA: sourceSha,
          CLOSEOUT_TOOLING_SHA: f.p,
        },
      },
    );
  await expect(qualifyCloseout("2")).resolves.toBeUndefined();
  await expect(qualifyCloseout("1")).rejects.toThrow("run attempt mismatch");
  await expect(qualifyCloseout("2", "f".repeat(40))).rejects.toThrow("Recovery target differs");
  const acquire = (runAttempt: number) =>
    acquirePublicationManifest(
      {
        repository: f.repository,
        runId: "991",
        expectedRunAttempts: { 991: runAttempt },
      },
      client,
    );
  await expect(acquire(2)).resolves.toEqual(manifest);
  await expect(acquire(1)).rejects.toThrow("recovery producer run attempt changed");
  const originalLoad = client.loadManifest.getMockImplementation();
  if (!originalLoad) {
    throw new Error("Missing manifest reader");
  }
  client.loadManifest.mockImplementation((id, attempt) => {
    const retained = originalLoad(id, attempt);
    return {
      ...retained,
      artifact: { ...retained.artifact, name: "full-release-validation-991-1" },
    };
  });
  await expect(acquire(2)).rejects.toThrow("manifest artifact is not compatible");
  expect(rerun).not.toHaveBeenCalled();
});

async function cliFixture(
  f: ReturnType<typeof fixture>["f"],
  producer: ReturnType<typeof fixture>["producer"],
  client: ReturnType<typeof fixture>["client"],
  selection?: ReturnType<typeof fixture>["normalCiSelection"],
) {
  mkdirSync(".openclaw/tmp", { recursive: true });
  const directory = mkdtempSync(".openclaw/tmp/recovery-cli-");
  directories.push(directory);
  const requestPath = join(directory, "request.json");
  const selectionPath = join(directory, "normal-ci.json");
  if (selection) {
    writeFileSync(selectionPath, JSON.stringify(selection));
  }
  await runReleaseRecoveryCli(
    [
      "--prepare-recovery",
      f.runId,
      "--output",
      requestPath,
      ...(selection ? ["--normal-ci-selection", selectionPath] : []),
    ],
    {},
    client,
  );
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
      GITHUB_RUN_ATTEMPT: String(producer.runAttempt),
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
      const getRun = client.getRun.getMockImplementation();
      if (!getRun) {
        throw new Error("Missing run reader");
      }
      client.getRun.mockImplementation(async (id) => {
        const run = await getRun(id);
        return id === child.runId ? { ...run, run_attempt: 2 } : run;
      });
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
      client.getRun.mockRejectedValue(new Error("HTTP 502"));
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
  ).toEqual([
    "pnpm install --frozen-lockfile --ignore-scripts",
    "node scripts/release-ci-summary.mjs --seal-recovery",
  ]);
});

it("substitutes original CI through the prepare/seal CLI without changing the immutable plan", async () => {
  const { f, normalCiSelection, producer, client, rerun, setSealed } = fixture(true);
  const originalPlan = JSON.stringify(f.plan);
  const { env, request, manifestPath } = await cliFixture(f, producer, client, normalCiSelection);
  expect(request.normalCiSelection).toEqual(normalCiSelection);
  expect(request.childAttempts).not.toHaveProperty("998");
  expect(request.childAttempts[normalCiSelection.runId]).toBe(1);
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
  expect(manifest.childRuns.normalCi).toBe(normalCiSelection.runId);
  expect(
    evidence.children.find((child: { role: string }) => child.role === "normalCi"),
  ).toMatchObject({
    runId: normalCiSelection.runId,
    workflowSha: normalCiSelection.workflowSha,
    sourceParentRunId: "500",
    sourceParentAttempt: 1,
  });
  expect(evidence.executionPlan?.sha256).toBe(f.plan.sha256);
  expect(f.plan.children.find((child) => child.key === "normalCi")?.runId).toBe("998");
  expect(JSON.stringify(f.plan)).toBe(originalPlan);
  expect(manifest.executionPlanSha256).toBe(f.plan.sha256);
  expect(manifest.workflowSha).toBe(f.q);
  expect(manifest.targetSha).toBe(f.c);
  expect(manifest.candidateBinding).toEqual(f.plan.candidate);
  expect(manifest.sourceAdmission).toEqual(f.plan.sourceAdmission);
  expect(client.getRun).not.toHaveBeenCalledWith("998");
  expect(rerun).not.toHaveBeenCalled();
});

it.each(["origin", "receipt", "inputs"])(
  "rejects substituted normal CI %s drift before sealing",
  async (failure) => {
    const { f, normalCiSelection, producer, client } = fixture(true);
    const selection = structuredClone(normalCiSelection);
    if (failure === "origin") {
      selection.sourceParentRunId = "999";
    }
    if (failure === "receipt") {
      selection.receiptSha256 = "f".repeat(64);
    }
    if (failure === "inputs") {
      selection.inputs.release_scope = "full";
    }
    await expect(cliFixture(f, producer, client, selection)).rejects.toThrow();
    if (failure === "inputs") {
      expect(client.validateChildReuse.mock.calls[0]?.[1].inputs).toMatchObject({
        release_scope: "npm-beta",
        include_android: "false",
        target_ref: f.c,
        qualification_baselines_json: f.plan.sourceAdmission.coverage.qualification_baselines_json,
      });
    }
  },
);

it.each(["selection", "dispatch"])(
  "rejects %s tampering when reading a sealed substitution",
  async (failure) => {
    const { f, normalCiSelection, producer, client, setSealed } = fixture(true);
    const { env, manifestPath } = await cliFixture(f, producer, client, normalCiSelection);
    await runReleaseRecoveryCli(["--seal-recovery"], env, client);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (failure === "selection") {
      delete manifest.recovery.normalCiSelection;
    } else {
      const getJobLog = client.getJobLog;
      client.getJobLog = async (id) =>
        (await getJobLog(id)).replaceAll(
          "https://github.com/openclaw/openclaw/actions/runs/" + normalCiSelection.runId,
          "https://github.com/openclaw/openclaw/actions/runs/998",
        );
    }
    setSealed(manifest);
    await expect(
      validateReleaseRunEvidence(
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
      ),
    ).rejects.toThrow();
  },
);
