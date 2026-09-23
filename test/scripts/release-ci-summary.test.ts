import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { crc32 } from "node:zlib";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { continueFailed, preflightContinuation } from "../../scripts/frv.mjs";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  releaseFlakeIntentSha256,
  selectReleaseFlakeIntent,
} from "../../scripts/full-release-flake-policy.mjs";
import {
  createPublicationAdmission,
  createPublicationObservations,
  createPublicationSourceFact,
  publicationDispatchEnvelope,
  publicationIntentInputs,
  publicationObservationJson,
  publicationSourceRequest,
  publicationSourceJson,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  composeReleaseAttemptJobs,
  MAX_RELEASE_ARTIFACT_BYTES,
  releaseCompositeJobsSha256,
  releaseExecutionPlanSha256,
  type ReleaseExecutionPlan,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  artifactDownloadArgs,
  artifactDownloadTimeoutMs,
  createReleaseEvidenceClient,
  expectedChildDispatches,
  expectedSelectedChildDispatches,
  githubRestArgs,
  manifestChildEntries,
  readManifestArtifactArchive,
  releaseAdvisoryJobEvidence,
  requiredChildKeysForRerunGroup,
  resolveManifestChildOriginAttempt,
  runReleaseCiGh,
  selectExactChildRun,
  selectExactChildRunFromPages,
  selectManifestArtifact,
  selectManifestParentJob,
  selectedChildKeys,
  tryReadReleaseDecisionArtifact,
  validateEvidenceReuseChain,
  validateManifestArtifactCompatibility,
  validateManifestArtifactIdentity,
  validateManifestChildRun,
  validateParentManifest,
  validateParentRunBinding,
  validatePerformanceArtifactOnlyJobs,
  validateReleaseRunEvidence,
  validateRequestedEvidenceReuse,
  validateTrustedProducerIdentity,
} from "../../scripts/release-ci-summary.mjs";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { fullReleaseCandidateBindingFixture } from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/release-ci-summary.mjs";
const MANIFEST_ARTIFACT_ENTRY = "full-release-validation-manifest.json";
const hasUnzip = spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function publicationRestoreFixture(fullCoverage = false, route: "normal" | "prepared" = "normal") {
  const fixture = trustedMainNpmFixture();
  const source = createPublicationSourceFact(
    publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        ref: fixture.targetSha,
        release_profile: "beta",
        rerun_group: "all",
        skip_package_telegram_e2e: true,
        ...(fullCoverage
          ? {
              provider: fixture.manifest.validationInputs.provider,
              mode: fixture.manifest.validationInputs.mode,
              npm_telegram_provider_mode: fixture.manifest.validationInputs.npmTelegramProviderMode,
            }
          : {}),
        trusted_workflow_json: publicationDispatchEnvelope(null, {
          validationPurpose: "publish",
          publicationSelection: {
            route,
            npmDistTag: "beta",
            publishOpenclawNpm: true,
            pluginPublishScope: "all-publishable",
            plugins: [],
          },
        }),
      }),
      PUBLICATION_TOOLING_JSON: JSON.stringify({
        fullRef: "refs/heads/main",
        sha: fixture.workflowSha,
      }),
      PUBLICATION_COVERAGE_POLICY: "npm-beta-v1",
      PUBLICATION_TARGET_CONTEXT: "release/2026.8.28",
      PUBLICATION_TARGET_SHA: fixture.targetSha,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: fixture.workflowSha,
      GITHUB_RUN_ID: fixture.runId,
      GITHUB_RUN_ATTEMPT: "1",
    }),
    { packages: [], platforms: [] },
    {
      version: "2026.8.28-beta.1",
      packages: [{ name: "openclaw", version: "2026.8.28-beta.1", targets: ["npm"] }],
      platforms: [],
    },
  );
  const time = "2026-08-28T12:00:00.000Z";
  const observations = createPublicationObservations(source, {
    sourceDigest: source.digest,
    prerequisitesCompletedAt: time,
    collectionStartedAt: time,
    collectionCompletedAt: time,
    npm: [
      {
        name: "openclaw",
        version: "2026.8.28-beta.1",
        required: true,
        observedAt: time,
        outcome: "observed",
        state: {
          packageExists: true,
          hasVersionHistory: true,
          selectedVersionExists: false,
          latestVersion: null,
        },
      },
    ],
    clawhub: [],
    pendingAuthority: [],
    plans: {
      npm: { all: [], candidates: [], skippedPublished: [], warnings: [] },
      clawhub: {
        all: [],
        candidates: [],
        skippedPublished: [],
        bootstrapCandidates: [],
        missingTrustedPublisher: [],
        warnings: [],
      },
    },
  });
  const admission = createPublicationAdmission(
    source,
    observations,
    {
      id: "444",
      name: `full-release-publication-observations-${fixture.runId}-1`,
      digest: `sha256:${"c".repeat(64)}`,
      sizeInBytes: 4096,
    },
    time,
  );
  const plan = Object.assign(fixture.executionPlan, {
    sourceAdmissionContract: "1",
    sourceAdmission: source,
    publicationAdmissionContract: "1",
    publicationAdmission: admission,
  });
  plan.sha256 = releaseExecutionPlanSha256(plan);
  return { ...fixture, plan, source, admission, request: { ...source, runAttempt: 2 } };
}

describe("original publication admission reader", () => {
  it.each([
    "complete",
    "changed-admission",
    "skipped-original-upload",
    "core-normal",
    "core-prepared",
    "wrong-channel",
    "wrong-target",
    "wrong-attempt",
    "wrong-route",
    "continuation",
    "continuation-mutated",
    "continuation-unsupported",
    "continuation-diagnostic-unsupported",
    "continuation-diagnostic-missing-witness",
  ])("authenticates B in the complete strict summary: %s", async (fault) => {
    const fixture = publicationRestoreFixture(
      true,
      fault === "core-prepared" ? "prepared" : "normal",
    );
    const continuation = fault.startsWith("continuation");
    const restoreContract = continuation && !fault.endsWith("unsupported");
    if (fault.includes("diagnostic")) {
      const {
        repository,
        candidateSha,
        targetContextRef,
        tooling,
        workflow,
        runId,
        runAttempt,
        coverage,
      } = fixture.source;
      fixture.source = createPublicationSourceFact(
        {
          repository,
          candidateSha,
          targetContextRef,
          tooling,
          workflow,
          runId,
          runAttempt,
          coverage,
          validationPurpose: "diagnostic",
          publicationSelection: null,
        },
        null,
        null,
      );
      Object.assign(fixture.plan, { sourceAdmission: fixture.source, publicationAdmission: null });
      fixture.plan.sha256 = releaseExecutionPlanSha256(fixture.plan);
    }
    Object.assign(fixture.manifest, {
      sourceAdmissionContract: "1",
      sourceAdmission: fixture.source,
      publicationAdmissionContract: "1",
      publicationAdmission: structuredClone(fixture.admission),
      trustedWorkflow: fixture.plan.trustedWorkflow,
      executionPlanSha256: fixture.plan.sha256,
    });
    Object.assign(fixture.manifest.validationInputs, publicationIntentInputs(fixture.source));
    delete fixture.manifest.evidenceReuse;
    const parent = {
      ...fixture.parentRun,
      name: "Full Release Validation",
      display_title: "Full Release Validation",
      repository: { full_name: "openclaw/openclaw" },
      head_repository: { full_name: "openclaw/openclaw" },
    };
    const originalJobs = [
      {
        id: 901,
        name: "Resolve target ref",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        steps: [{ name: "Finalize publication admission", conclusion: "success" }],
      },
      {
        id: 902,
        name: "Seal release execution plan",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        steps: [
          {
            name: "Seal immutable release execution plan",
            number: 5,
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-28T12:01:00.000Z",
            completed_at: "2026-08-28T12:01:01.000Z",
          },
          {
            name: "Upload immutable release execution plan",
            number: 6,
            status: "completed",
            conclusion: fault === "skipped-original-upload" ? "skipped" : "success",
            started_at: "2026-08-28T12:01:01.000Z",
            completed_at: "2026-08-28T12:01:03.000Z",
          },
          ...(restoreContract
            ? [
                {
                  name: "Record immutable release execution plan digest",
                  number: 7,
                  status: "completed",
                  conclusion: fault.endsWith("missing-witness") ? "skipped" : "success",
                  started_at: "2026-08-28T12:01:03.000Z",
                  completed_at: "2026-08-28T12:01:03.000Z",
                },
              ]
            : []),
        ],
      },
    ];
    const retained = {
      plan: fixture.plan,
      artifact: {
        created_at: "2026-08-28T12:01:02.000Z",
        workflow_run: { head_sha: fixture.workflowSha, head_branch: "main" },
      },
    };
    const client = {
      ...fixture.client,
      getJobLog: async (id: number) =>
        id === 902
          ? `2026-08-28T12:01:03.750Z FRV_EXECUTION_PLAN_SHA256=${releaseExecutionPlanSha256(fixture.plan)}\n`
          : fixture.client.getJobLog(id),
      getRun: async (id: string) => fixture.client.getRun(id),
      getParentJobs: async (id: string) => fixture.client.getParentJobs(id),
      getWorkflowSource: vi.fn(
        () =>
          'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n' +
          (restoreContract ? '  FULL_RELEASE_EXECUTION_PLAN_RESTORE_CONTRACT: "1"\n' : ""),
      ),
      getRunAttempt: vi.fn((runId: string, attempt: number) => {
        expect(attempt).toBe(1);
        return runId === fixture.runId ? parent : fixture.client.getRun(runId);
      }),
      getArtifact: () => {
        throw new Error("unexpected artifact lookup after fixture archive load");
      },
      getRunAttemptJobs: vi.fn(async (runId: string) =>
        runId === fixture.runId ? originalJobs : fixture.client.getRunAttemptJobs(runId),
      ),
      loadExecutionPlanEvidence: vi.fn(() => retained),
    };
    if (fault === "changed-admission") {
      const changed = structuredClone(fixture.admission);
      const row = expectDefined(changed.observations.npm[0], "required root observation");
      if (row.outcome !== "observed") {
        throw new Error("fixture root observation unavailable");
      }
      row.state.latestVersion = "2026.8.27";
      changed.binding.observationsDigest = `sha256:${createHash("sha256").update(publicationObservationJson(changed.observations)).digest("hex")}`;
      Object.assign(fixture.manifest, { publicationAdmission: changed });
    }
    const strictOptions = {
      runId: fixture.runId,
      verifierSourceContent: readFileSync(SCRIPT),
      verifierSourceSha: "c".repeat(40),
    };
    const consumerCase = !["complete", "changed-admission", "skipped-original-upload"].includes(
      fault,
    );
    if (fault.startsWith("continuation")) {
      const observed = structuredClone(fixture.plan);
      if (fault === "continuation-mutated") {
        const admission = expectDefined(observed.publicationAdmission, "admission");
        const row = expectDefined(admission.observations.npm[0], "root observation");
        if (row.outcome !== "observed") {
          throw new Error("fixture root observation unavailable");
        }
        row.state.latestVersion = "2026.8.27";
        admission.binding.observationsDigest = `sha256:${createHash("sha256").update(publicationObservationJson(admission.observations)).digest("hex")}`;
        observed.sha256 = releaseExecutionPlanSha256(observed);
      }
      const continuationClient = {
        getReleaseEvidenceClient: () => client,
        getRun: client.getRun,
        getAttemptJobs: vi.fn(async () => {
          throw new Error("unsupported parent must not read child attempts");
        }),
        getParentJobs: async () => [
          ...originalJobs,
          ...fixture.client.getParentJobs(fixture.runId),
        ],
        getRunAttempt: async (id: string) =>
          id === fixture.runId ? parent : fixture.client.getRun(id),
        getJobLog: async (id: number) =>
          id === 901
            ? `RERUN_GROUP: all\nFAIL_FAST: false\nTARGET_SHA: ${fixture.targetSha}`
            : fixture.client.getJobLog(id),
        rerunFailed: vi.fn(),
        rerunParent: vi.fn(),
      };
      const unsupported = fault.endsWith("unsupported") || fault.endsWith("missing-witness");
      const result = unsupported
        ? continueFailed(observed, fixture.runId, continuationClient)
        : preflightContinuation(observed, fixture.runId, continuationClient);
      if (fault === "continuation") {
        await expect(result).resolves.toBeDefined();
      } else if (unsupported) {
        await expect(result).rejects.toThrow(
          fault.endsWith("unsupported")
            ? "frozen workflow cannot restore publication admission"
            : "publication original plan digest witness did not succeed",
        );
        expect(continuationClient.rerunFailed).not.toHaveBeenCalled();
        expect(continuationClient.rerunParent).not.toHaveBeenCalled();
        expect(continuationClient.getAttemptJobs).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toThrow(
          "continuation differs from the authenticated original publication plan",
        );
      }
      expect(client.loadExecutionPlanEvidence).toHaveBeenCalledTimes(unsupported ? 0 : 1);
      return;
    }
    const result = consumerCase
      ? authenticateFullReleaseValidationEvidence(
          {
            run: parent,
            expectedRepository: "openclaw/openclaw",
            expectedRunId: fixture.runId,
            expectedRunAttempt: fault === "wrong-attempt" ? 2 : 1,
            expectedTargetSha: fault === "wrong-target" ? "d".repeat(40) : fixture.targetSha,
            expectedReleaseTag: "v2026.8.28-beta.1",
            isTrustedMainAncestor: () => true,
            verifierSourceContent: strictOptions.verifierSourceContent,
            verifierSourceSha: strictOptions.verifierSourceSha,
            ...(fault === "wrong-route"
              ? {
                  expectedPublicationSelection: {
                    ...expectDefined(fixture.source.publicationSelection, "publication selection"),
                    route: "prepared" as const,
                  },
                }
              : {
                  expectedCoreNpmPublication: {
                    npmDistTag: fault === "wrong-channel" ? "latest" : "beta",
                  },
                }),
          },
          client,
        )
      : validateReleaseRunEvidence(strictOptions, client);
    if (["complete", "core-normal", "core-prepared"].includes(fault)) {
      const value = await result;
      const verified = "evidence" in value ? value.evidence : value;
      expect(verified.children).toHaveLength(5);
      expect(verified.current.manifest.publicationAdmission).toEqual(fixture.admission);
      expect(client.loadExecutionPlanEvidence).toHaveBeenCalledTimes(1);
      expect(client.getWorkflowSource).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toThrow(
        /publication|consumer|targetSha mismatch|differently selected|attempt differs/iu,
      );
    }
  });

  it.each([
    "complete",
    "workflow-restore",
    "workflow-restore-failed-resolution",
    "workflow-plan-restore",
    "workflow-plan-mutated",
    "workflow-plan-prewrite",
    "workflow-restore-cached",
    "workflow-plan-cached",
    "cached-plan-mutated",
    "cached-plan-missing-witness",
    "cached-plan-duplicate-witness",
    "cached-plan-outside-witness",
    "cached-plan-wrong-witness-step",
    "cached-plan-duplicate-witness-step",
    "cached-plan-failed-witness",
    "cached-plan-failed-upload",
    "cached-plan-historical",
    "reuploaded-plan",
    "reuploaded-plan-mutated",
    "interrupted-sealer",
    "missing-sealer",
    "duplicate-sealer",
    "later-sealer",
    "skipped-seal",
    "failed-upload",
    "skipped-upload",
    "late-artifact",
    "upload-before-seal",
    "wrong-repository",
    "wrong-attempt",
    "wrong-workflow",
    "wrong-sha",
    "failed-resolution",
    "deleted-capability",
    "deleted-admission",
    "missing-plan",
    "duplicate-plan",
    "incomplete-list",
    "wrong-archive-digest",
    "extra-entry",
    "symlink-entry",
    "changed-selection",
  ])("authenticates retained attempt one before any new observations: %s", (fault) => {
    const fixture = publicationRestoreFixture();
    const cachedRestore = fault.includes("cached");
    const witnessContract =
      (cachedRestore && fault !== "cached-plan-historical") || fault.startsWith("reuploaded-plan");
    const originalPlanDigest = releaseExecutionPlanSha256(fixture.plan);
    if (fault === "cached-plan-mutated" || fault === "reuploaded-plan-mutated") {
      const row = expectDefined(fixture.admission.observations.npm[0], "root observation");
      if (row.outcome !== "observed") {
        throw new Error("fixture root observation unavailable");
      }
      row.state.latestVersion = "2026.8.27";
      fixture.admission.binding.observationsDigest = `sha256:${createHash("sha256").update(publicationObservationJson(fixture.admission.observations)).digest("hex")}`;
      fixture.plan.sha256 = releaseExecutionPlanSha256(fixture.plan);
    }
    const root = tempDirs.make("publication-original-reader-");
    const request = join(root, "request.json");
    const fixturesPath = join(root, "fixtures.json");
    const archivePath = join(root, "plan.zip");
    const callsPath = join(root, "calls.jsonl");
    const gh = join(root, "gh");
    const workflowPath = ".github/workflows/full-release-validation.yml";
    const workflowBytes = Buffer.from(
      'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n' +
        (fault === "deleted-capability"
          ? ""
          : '  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n') +
        (witnessContract ? '  FULL_RELEASE_EXECUTION_PLAN_RESTORE_CONTRACT: "1"\n' : ""),
    );
    if (fault === "deleted-admission") {
      Reflect.deleteProperty(fixture.plan, "publicationAdmissionContract");
      Reflect.deleteProperty(fixture.plan, "publicationAdmission");
      fixture.plan.sha256 = releaseExecutionPlanSha256(fixture.plan);
    }
    if (fault === "changed-selection") {
      fixture.request.publicationSelection = {
        ...expectDefined(fixture.request.publicationSelection, "publication selection"),
        route: "prepared",
      };
    }
    if (fault === "interrupted-sealer") {
      const pendingGh = gh;
      const ready = join(root, "pending-gh-ready");
      const settled = join(root, "pending-gh-settled");
      const written = join(root, "interrupted-plan.json");
      const outputsPath = join(root, "interrupted-outputs");
      const admissionPath = join(root, "source-admission.json");
      writeFileSync(
        admissionPath,
        JSON.stringify({
          sourceAdmissionContract: "1",
          sourceAdmission: fixture.source,
          publicationAdmissionContract: "1",
          publicationAdmission: fixture.admission,
        }),
      );
      writeFileSync(
        pendingGh,
        `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const parent = process.ppid;
process.once("exit", () => require("node:fs").writeFileSync(${JSON.stringify(settled)}, "settled"));
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 10);
setTimeout(() => {}, 30000);
`,
        { mode: 0o755 },
      );
      const inputs = {
        childPhaseVersion: 3,
        sourceAdmissionContract: "1",
        sourceAdmission: fixture.source,
        parentRunId: fixture.runId,
        parentRunAttempt: 1,
        workflowRef: "main",
        workflowSha: fixture.workflowSha,
        rerunGroup: "all",
        coveragePolicy: fixture.plan.coveragePolicy,
        targetVersion: fixture.source.projection!.version,
        resolveTargetResult: "success",
        candidateAcquisitionResult: "skipped",
        candidateRequestInput: fixture.plan.candidateRequest,
        trustedWorkflow: fixture.plan.trustedWorkflow,
        evidenceReuse: true,
        evidenceRunId: "99",
        evidenceRootRunId: "99",
        evidencePolicy: "exact-target-full-validation-v1",
        evidenceSha: fixture.targetSha,
        evidenceRunUrl: "https://example.invalid/runs/99",
        evidenceChangedPaths: [],
      };
      const interrupted = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const child = spawn(process.execPath, [${JSON.stringify(resolve("scripts/full-release-validation-state.mjs"))}, "plan"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
try {
  while (!existsSync(${JSON.stringify(ready)}) && child.exitCode === null) await delay(10);
  if (!existsSync(${JSON.stringify(ready)})) {
    await closed;
    throw new Error("reuse did not reach controlled gh: " + (existsSync(${JSON.stringify(written)}) ? readFileSync(${JSON.stringify(written)}, "utf8") : "no checkpoint"));
  }
  child.kill("SIGTERM");
  const result = await closed;
  if (result.code !== 1 || result.signal !== null) throw new Error("interruption did not write and exit 1");
  const settlementDeadline = Date.now() + 2000;
  while (!existsSync(${JSON.stringify(settled)}) && Date.now() < settlementDeadline) await delay(10);
  if (!existsSync(${JSON.stringify(settled)})) throw new Error("controlled gh did not settle after owner interruption");
} finally { clearTimeout(timeout); }
`,
        ],
        {
          encoding: "utf8",
          timeout: 12_000,
          env: {
            PATH: `${root}:${process.env.PATH ?? ""}`,
            OPENCLAW_GH_BIN: pendingGh,
            GH_TOKEN: "synthetic-evidence-token",
            FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1",
            FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1",
            FULL_RELEASE_EXECUTION_PLAN_PATH: written,
            PUBLICATION_ADMISSION_PATH: admissionPath,
            FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(inputs),
            GITHUB_OUTPUT: outputsPath,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_RUN_ID: fixture.runId,
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_REF_NAME: "main",
            GITHUB_SHA: fixture.workflowSha,
            TARGET_SHA: fixture.targetSha,
            RELEASE_PROFILE: "beta",
            RERUN_GROUP: "all",
          },
        },
      );
      expect(interrupted.status, interrupted.stderr).toBe(0);
      Object.assign(fixture.plan, JSON.parse(readFileSync(written, "utf8")));
      expect(fixture.plan.errors).toContainEqual(
        expect.objectContaining({ kind: "collector_cancelled" }),
      );
      expect(fixture.plan.publicationAdmission).toEqual(fixture.admission);
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
      const upload = workflow.jobs.release_execution_plan.steps.find(
        (step: { name: string }) => step.name === "Upload immutable release execution plan",
      );
      const outputs = Object.fromEntries(
        readFileSync(outputsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      expect(outputs.sha256).toBe(fixture.plan.sha256);
      expect(outputs.source_parent_attempt).toBe("1");
      expect(
        runInNewContext(
          String(upload.if)
            .replace(/^\$\{\{|\}\}$/gu, "")
            .trim(),
          {
            always: () => true,
            github: { run_attempt: 1 },
            steps: { plan: { outputs } },
          },
        ),
      ).toBe(true);
      expect(upload.with.overwrite).toBe(false);
    }
    const entry = "full-release-execution-plan.json";
    const archive = makeStoredZip({
      [entry]: JSON.stringify(fixture.plan) + "\n",
      ...(fault === "extra-entry" ? { "unexpected.json": "{}" } : {}),
    });
    if (fault === "symlink-entry") {
      const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      archive[central + 5] = 3;
      archive.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    }
    const artifact = {
      id: 456,
      name: `full-release-execution-plan-${fixture.runId}`,
      size_in_bytes: archive.length,
      digest: `sha256:${fault === "wrong-archive-digest" ? "a".repeat(64) : createHash("sha256").update(archive).digest("hex")}`,
      expired: false,
      created_at:
        fault === "late-artifact" || fault.startsWith("reuploaded-plan")
          ? "2026-08-29T12:01:02.000Z"
          : "2026-08-28T12:01:02.000Z",
      workflow_run: {
        id: Number(fixture.runId),
        head_branch: "main",
        head_sha: fixture.workflowSha,
      },
    };
    const artifacts =
      fault === "missing-plan" || cachedRestore
        ? []
        : fault === "duplicate-plan"
          ? [artifact, { ...artifact, id: 457 }]
          : [artifact];
    const fixtures = {
      parent: {
        id: Number(fixture.runId),
        repository: {
          full_name: fault === "wrong-repository" ? "other/repo" : "openclaw/openclaw",
        },
        head_repository: { full_name: "openclaw/openclaw" },
        path: fault === "wrong-workflow" ? ".github/workflows/ci.yml" : workflowPath,
        event: "workflow_dispatch",
        run_attempt: fault === "wrong-attempt" ? 2 : 1,
        head_sha: fault === "wrong-sha" ? "f".repeat(40) : fixture.workflowSha,
        head_branch: "main",
      },
      workflow: {
        type: "file",
        encoding: "base64",
        path: workflowPath,
        size: workflowBytes.length,
        sha: createHash("sha1")
          .update(`blob ${workflowBytes.length}\0`)
          .update(workflowBytes)
          .digest("hex"),
        content: workflowBytes.toString("base64"),
      },
      jobs: {
        total_count: fault === "missing-sealer" ? 1 : fault === "duplicate-sealer" ? 3 : 2,
        jobs: [
          {
            id: 999,
            name: "Resolve target ref",
            run_attempt: 1,
            status: "completed",
            conclusion: fault.endsWith("failed-resolution") ? "failure" : "success",
            steps: [{ name: "Finalize publication admission", conclusion: "success" }],
          },
          ...(fault === "missing-sealer"
            ? []
            : Array.from({ length: fault === "duplicate-sealer" ? 2 : 1 }, (_, index) => ({
                id: 1000 + index,
                name: "Seal release execution plan",
                run_attempt: fault === "later-sealer" ? 2 : 1,
                status: "completed",
                conclusion: fault === "interrupted-sealer" ? "failure" : "success",
                steps: [
                  {
                    name: "Seal immutable release execution plan",
                    number: 5,
                    status: "completed",
                    conclusion:
                      fault === "skipped-seal"
                        ? "skipped"
                        : fault === "interrupted-sealer"
                          ? "failure"
                          : "success",
                    started_at: "2026-08-28T12:01:00.000Z",
                    completed_at: "2026-08-28T12:01:01.000Z",
                  },
                  {
                    name: "Upload immutable release execution plan",
                    number: fault === "upload-before-seal" ? 4 : 6,
                    status: "completed",
                    conclusion:
                      fault === "failed-upload" || fault === "cached-plan-failed-upload"
                        ? "failure"
                        : fault === "skipped-upload"
                          ? "skipped"
                          : "success",
                    started_at: "2026-08-28T12:01:01.000Z",
                    completed_at: "2026-08-28T12:01:03.000Z",
                  },
                  ...(witnessContract
                    ? Array.from(
                        { length: fault === "cached-plan-duplicate-witness-step" ? 2 : 1 },
                        (_witness, witnessIndex) => ({
                          name:
                            fault === "cached-plan-wrong-witness-step"
                              ? "Unrelated successful step"
                              : "Record immutable release execution plan digest",
                          number: 7 + witnessIndex,
                          status: "completed",
                          conclusion:
                            fault === "cached-plan-failed-witness" ? "failure" : "success",
                          started_at: "2026-08-28T12:01:03.000Z",
                          completed_at: "2026-08-28T12:01:03.000Z",
                        }),
                      )
                    : []),
                ],
              }))),
        ],
      },
      listing: { total_count: fault === "incomplete-list" ? 2 : artifacts.length, artifacts },
      artifact,
      log:
        fault === "cached-plan-missing-witness"
          ? "2026-08-28T12:01:03.750Z unrelated output\n"
          : `${fault === "cached-plan-outside-witness" ? "2026-08-28T12:01:02.750Z" : "2026-08-28T12:01:03.750Z"} FRV_EXECUTION_PLAN_SHA256=${originalPlanDigest}\n`.repeat(
              fault === "cached-plan-duplicate-witness" ? 2 : 1,
            ),
    };
    writeFileSync(request, JSON.stringify(fixture.request));
    writeFileSync(fixturesPath, JSON.stringify(fixtures));
    writeFileSync(archivePath, archive);
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2), endpoint = args[1];
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] !== "api") throw new Error("unexpected non-read");
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixturesPath)}, "utf8"));
let value;
if (endpoint === "repos/openclaw/openclaw/actions/runs/${fixture.runId}/attempts/1") value = fixture.parent;
else if (endpoint.startsWith("repos/openclaw/openclaw/actions/runs/${fixture.runId}/attempts/1/jobs?")) value = fixture.jobs;
else if (endpoint === "repos/openclaw/openclaw/contents/${workflowPath}?ref=${fixture.workflowSha}") value = fixture.workflow;
else if (endpoint.startsWith("repos/openclaw/openclaw/actions/runs/${fixture.runId}/artifacts?")) value = fixture.listing;
else if (endpoint === "repos/openclaw/openclaw/actions/jobs/1000/logs") {
  process.stdout.write(fixture.log); process.exit(0);
}
else if (endpoint === "repos/openclaw/openclaw/actions/artifacts/456") value = fixture.artifact;
else if (endpoint === "repos/openclaw/openclaw/actions/artifacts/456/zip") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(archivePath)})); process.exit(0);
} else throw new Error("unplanned evidence request");
process.stdout.write(JSON.stringify(value));
`,
      { mode: 0o755 },
    );
    const workflowRestore = fault.startsWith("workflow-restore");
    const planRestore = fault.startsWith("workflow-plan");
    const cachedPlanPath = join(
      root,
      "full-release-execution-plan",
      "full-release-execution-plan.json",
    );
    const originalPlanBytes = JSON.stringify(fixture.plan) + "\n";
    if (planRestore || cachedRestore) {
      mkdirSync(dirname(cachedPlanPath), { recursive: true });
      const cached = structuredClone(fixture.plan);
      if (fault === "workflow-plan-mutated") {
        // A self-consistent cache is still not authority over the authenticated original.
        const row = fixture.admission.observations.npm[0]!;
        const changedAdmission = structuredClone(fixture.admission);
        const changed = changedAdmission.observations.npm[0]!;
        expect(row.outcome).toBe("observed");
        if (changed.outcome === "observed") {
          changed.state.latestVersion = "2026.8.27";
        }
        changedAdmission.binding.observationsDigest = `sha256:${createHash("sha256").update(publicationObservationJson(changedAdmission.observations)).digest("hex")}`;
        cached.publicationAdmission = changedAdmission;
        cached.sha256 = releaseExecutionPlanSha256(cached);
      }
      writeFileSync(
        cachedPlanPath,
        fault === "workflow-plan-mutated" ? JSON.stringify(cached) + "\n" : originalPlanBytes,
      );
    }
    let restoreCommand: string | undefined;
    if (workflowRestore) {
      writeFileSync(join(root, "publication-source-request.json"), JSON.stringify(fixture.request));
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
      restoreCommand = workflow.jobs.resolve_target.steps.find(
        (step: { name: string }) => step.name === "Admit publication source",
      ).run;
    }
    const result = spawnSync(
      workflowRestore ? "bash" : process.execPath,
      planRestore
        ? [resolve("scripts/full-release-validation-state.mjs"), "plan"]
        : workflowRestore
          ? ["-c", expectDefined(restoreCommand, "actual admission command")]
          : [
              "--input-type=module",
              "--eval",
              `
import { readFileSync } from "node:fs";
import { restoreOriginalPublicationAdmission } from ${JSON.stringify(pathToFileURL(resolve(SCRIPT)).href)};
const request = JSON.parse(readFileSync(${JSON.stringify(request)}, "utf8"));
const restored = await restoreOriginalPublicationAdmission({ request${cachedRestore ? `, cachedPlan: JSON.parse(readFileSync(${JSON.stringify(cachedPlanPath)}, "utf8"))` : ""} });
process.stdout.write(JSON.stringify(restored));
`,
            ],
      {
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH ?? ""}`,
          OPENCLAW_GH_BIN: gh,
          GH_TOKEN: "synthetic-evidence-token",
          GITHUB_RUN_ATTEMPT:
            fault === "workflow-plan-prewrite" ? "1" : fault === "workflow-plan-cached" ? "3" : "2",
          RUNNER_TEMP: root,
          FULL_RELEASE_EXECUTION_PLAN_PATH: cachedPlanPath,
          GITHUB_OUTPUT: join(root, "outputs"),
          PUBLICATION_REQUIRED: "true",
          // A new observation path cannot run without this unavailable target.
          PUBLICATION_TARGET_ROOT: join(root, "unavailable-candidate"),
          ...(planRestore
            ? {
                FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1",
                FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1",
                FULL_RELEASE_EXECUTION_PLAN_PATH: cachedPlanPath,
                FULL_RELEASE_RESTORE_PLAN: fault === "workflow-plan-prewrite" ? "false" : "true",
                FULL_RELEASE_PLAN_INPUTS_JSON: "must-not-be-read",
                SOURCE_ADMISSION_JSON: JSON.stringify(fixture.source),
                CANDIDATE_REQUEST_JSON: JSON.stringify(fixture.plan.candidateRequest),
                GITHUB_REPOSITORY: "openclaw/openclaw",
                GITHUB_RUN_ID: fixture.runId,
                GITHUB_SHA: fixture.workflowSha,
                GITHUB_REF_NAME: "main",
                RELEASE_PROFILE: fixture.source.coverage.release_profile,
                RERUN_GROUP: fixture.source.coverage.rerun_group,
                TARGET_SHA: fixture.targetSha,
                TARGET_VERSION: fixture.source.projection!.version,
                TARGET_CONTEXT_REF: fixture.source.targetContextRef,
                COVERAGE_POLICY: fixture.source.coverage.coverage_policy,
              }
            : {}),
        },
        timeout: 10_000,
      },
    );
    const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";
    expect(calls).not.toContain("registry.npmjs.org");
    expect(calls).not.toContain("clawhub.ai");
    expect(calls).not.toContain("auth");
    expect(calls).not.toContain("/444");
    if (fault === "workflow-plan-restore" || fault === "workflow-plan-cached") {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(cachedPlanPath, "utf8")).toBe(originalPlanBytes);
      if (cachedRestore) {
        expect(calls).not.toContain("/artifacts");
      }
    } else if (
      fault === "complete" ||
      fault === "workflow-restore" ||
      fault === "workflow-restore-cached" ||
      fault === "reuploaded-plan" ||
      fault === "interrupted-sealer"
    ) {
      expect(result.status, result.stderr).toBe(0);
      const restored = workflowRestore
        ? {
            source: JSON.parse(
              readFileSync(join(root, "publication-source-admission.json"), "utf8"),
            ),
            admission: JSON.parse(readFileSync(join(root, "publication-admission.json"), "utf8"))
              .publicationAdmission,
            plan: fixture.plan,
          }
        : JSON.parse(result.stdout);
      expect(restored.source).toEqual(fixture.source);
      expect(restored.admission).toEqual(fixture.admission);
      expect(restored.plan.sha256).toBe(fixture.plan.sha256);
      if (cachedRestore) {
        expect(calls).not.toContain("/artifacts");
      }
      expect(existsSync(join(root, "publication-observations.json"))).toBe(false);
    } else {
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(join(root, "publication-admission.json"))).toBe(false);
      if (fault === "workflow-plan-mutated") {
        expect(result.stderr).toContain("differs from its authenticated original");
      }
    }
    if (planRestore && !cachedRestore) {
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
      const upload = workflow.jobs.release_execution_plan.steps.find(
        (step: { name: string }) => step.name === "Upload immutable release execution plan",
      );
      const outputs = existsSync(join(root, "outputs"))
        ? Object.fromEntries(
            readFileSync(join(root, "outputs"), "utf8")
              .trim()
              .split("\n")
              .map((line) => line.split("=")),
          )
        : {};
      const condition = String(upload.if)
        .replace(/^\$\{\{|\}\}$/gu, "")
        .trim();
      const uploadSelected = runInNewContext(condition, {
        always: () => true,
        github: { run_attempt: fault === "workflow-plan-prewrite" ? 1 : 2 },
        steps: { plan: { outputs: { sha256: "", source_parent_attempt: "", ...outputs } } },
      });
      if (uploadSelected && upload.with.overwrite === true) {
        const replacement = makeStoredZip({ [entry]: readFileSync(cachedPlanPath, "utf8") });
        fixtures.artifact = {
          ...artifact,
          size_in_bytes: replacement.length,
          digest: `sha256:${createHash("sha256").update(replacement).digest("hex")}`,
          created_at: "2026-08-29T12:01:02.000Z",
        };
        fixtures.listing.artifacts = [fixtures.artifact];
        writeFileSync(fixturesPath, JSON.stringify(fixtures));
        writeFileSync(archivePath, replacement);
      }
      const subsequent = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import { restoreOriginalPublicationAdmission } from ${JSON.stringify(pathToFileURL(resolve(SCRIPT)).href)};
const restored = await restoreOriginalPublicationAdmission({ request: ${JSON.stringify(fixture.request)} });
process.stdout.write(JSON.stringify(restored.plan));
`,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: `${root}:${process.env.PATH ?? ""}`,
            OPENCLAW_GH_BIN: gh,
            GH_TOKEN: "synthetic-evidence-token",
          },
          timeout: 10_000,
        },
      );
      expect.soft(uploadSelected).toBe(false);
      expect.soft(subsequent.status, subsequent.stderr).toBe(0);
      if (subsequent.status === 0) {
        expect(JSON.parse(subsequent.stdout)).toEqual(fixture.plan);
      }
      expect(readFileSync(archivePath)).toEqual(archive);
    }
  });
});

describe("GitHub API commands", () => {
  it("delegates authentication to gh for REST and artifact requests", () => {
    expect(githubRestArgs("actions/runs/123", "owner/repo")).toEqual([
      "api",
      "repos/owner/repo/actions/runs/123",
    ]);
    expect(artifactDownloadArgs(456, "owner/repo")).toEqual([
      "api",
      "repos/owner/repo/actions/artifacts/456/zip",
    ]);
  });

  it("budgets large artifact downloads for a conservative transfer rate", () => {
    expect(artifactDownloadTimeoutMs(55 * 1024 * 1024)).toBeGreaterThan(60_000);
    expect(artifactDownloadTimeoutMs(245 * 1024 * 1024)).toBeGreaterThan(15 * 60_000);
    expect(() => artifactDownloadTimeoutMs(0)).toThrow("artifact download size is invalid");
  });

  it.skipIf(!hasUnzip)("renders phased advisories with cached GitHub reads", () => {
    const root = mkdtempSync(join(tmpdir(), "release-ci-gh-routing-"));
    const workflowSha = "0".repeat(40);
    const targetSha = "8".repeat(40);
    const verifierSha = "c".repeat(40);
    const fixture = trustedMainPackageFixture({ manifestVersion: 3, targetSha, workflowSha });
    const runId = fixture.runId;
    const childRunId = String(fixture.childRun.id);
    const candidateChild = expectDefined(
      expectedChildDispatches(runId, 1, "main", 3).find(
        (child) => child.manifestKey === "releaseChecksCandidate",
      ),
      "candidate child",
    );
    fixture.parentJob.name = candidateChild.parentJobName;
    fixture.childRun.display_title = candidateChild.displayTitle;
    fixture.childRun.conclusion = "failure";
    const composite = composeReleaseAttemptJobs(
      [
        {
          jobs: [
            {
              name: "cross_os_release_checks / Windows / packaged fresh",
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "cross_os_release_checks / macOS / packaged fresh",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "cross_os_release_checks / Linux / packaged fresh",
              status: "completed",
              conclusion: "success",
            },
          ],
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    const childEvidence = {
      releaseChecksCandidate: {
        compositeJobsSha256: composite.sha256,
        dispatchActor: "github-actions[bot]",
        effectiveRunAttempt: 1,
        jobs: composite.jobs,
        observedRunAttempts: [1],
        plannedRunAttempt: 1,
        repository: "openclaw/openclaw",
        runId: childRunId,
        triggeringActor: "github-actions[bot]",
      },
    };
    Object.assign(fixture.manifest, {
      advisoryJobs: releaseAdvisoryJobEvidence(childEvidence, "full", "main"),
      childEvidence,
      childRuns: {
        releaseChecksCandidate: childRunId,
        normalCi: "",
        npmTelegram: "",
        pluginPrereleaseIndependent: "",
        pluginPrereleaseCandidate: "",
        releaseChecksIndependent: "",
      },
      version: 4,
    });
    const advisoryJobs = releaseAdvisoryJobEvidence(childEvidence, "full", "main");
    const firstAdvisory = expectDefined(advisoryJobs[0], "first advisory job");
    for (const advisoryClaim of [
      [
        { ...firstAdvisory, job: "cross_os_release_checks / Linux / packaged fresh" },
        ...advisoryJobs.slice(1),
      ],
      [
        {
          ...firstAdvisory,
          conclusion: firstAdvisory.conclusion === "success" ? "failure" : "success",
        },
        ...advisoryJobs.slice(1),
      ],
      advisoryJobs.slice(1),
    ]) {
      expect(() =>
        validateParentManifest(
          { ...fixture.manifest, advisoryJobs: advisoryClaim },
          { runAttempt: 1, runId, workflowRef: "main", workflowSha },
        ),
      ).toThrow("release validation advisory jobs differ from canonical policy evidence");
    }
    const artifactId = fixture.artifact.id;
    const archive = makeStoredZip({
      [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(fixture.manifest),
    });
    const archivePath = join(root, "manifest.zip");
    const fixturesPath = join(root, "fixtures.json");
    const shimLog = join(root, "shim.log");
    const plainLog = join(root, "plain.log");
    const shimGh = join(root, "gh");
    const plainGh = join(root, "plain-gh");
    fixture.artifact.digest = artifactDigest(archive);
    fixture.artifact.size_in_bytes = archive.length;
    writeFileSync(archivePath, archive);
    writeFileSync(
      fixturesPath,
      JSON.stringify({
        artifact: fixture.artifact,
        artifactList: { artifacts: [fixture.artifact] },
        child: fixture.childRun,
        jobLog: `TARGET_SHA: ${targetSha}\nDispatched: https://github.com/openclaw/openclaw/actions/runs/${childRunId} (attempt 1)`,
        jobs: { jobs: [fixture.parentJob] },
        lineage: { merge_base_commit: { sha: workflowSha }, status: "ahead" },
        parent: fixture.parentRun,
        parentView: fixture.parentView,
        rate: { resources: { core: { limit: 5000, remaining: 4999, reset: 2_000_000_000 } } },
        workflow: {
          type: "file",
          encoding: "base64",
          path: ".github/workflows/full-release-validation.yml",
          content: Buffer.from("name: Full Release Validation\n").toString("base64"),
          size: Buffer.byteLength("name: Full Release Validation\n"),
          sha: createHash("sha1")
            .update(
              `blob ${Buffer.byteLength("name: Full Release Validation\n")}\0name: Full Release Validation\n`,
            )
            .digest("hex"),
        },
      }),
    );
    writeFileSync(
      shimGh,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + "\\n");
const fixtures = JSON.parse(readFileSync(process.env.FIXTURES, "utf8"));
const endpoint = args[1] ?? "";
let output;
if (args[0] === "run" && args[1] === "view") output = fixtures.parentView;
else if (args[0] === "auth" && args[1] === "token") output = "wrapper-only-token";
else if (endpoint === "rate_limit") output = fixtures.rate;
else if (endpoint === "repos/openclaw/openclaw/contents/.github/workflows/full-release-validation.yml?ref=${workflowSha}") output = fixtures.workflow;
else if (endpoint === "repos/openclaw/openclaw/actions/runs/${runId}") output = fixtures.parent;
else if (endpoint.startsWith("repos/openclaw/openclaw/actions/runs/${runId}/artifacts?")) output = fixtures.artifactList;
else if (endpoint === "repos/openclaw/openclaw/actions/artifacts/${artifactId}") output = fixtures.artifact;
else if (endpoint.startsWith("repos/openclaw/openclaw/actions/runs/${runId}/jobs?")) output = fixtures.jobs;
else if (endpoint === "repos/openclaw/openclaw/actions/runs/${childRunId}") output = fixtures.child;
else if (endpoint === "repos/openclaw/openclaw/actions/jobs/${fixture.parentJob.id}/logs") output = fixtures.jobLog;
else if (endpoint === "repos/openclaw/openclaw/compare/${workflowSha}...${verifierSha}?per_page=1&page=2") output = fixtures.lineage;
else { console.error("unexpected cached gh request: " + args.join(" ")); process.exit(43); }
process.stdout.write(typeof output === "string" ? output : JSON.stringify(output));
`,
    );
    writeFileSync(
      plainGh,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.PLAIN_LOG, JSON.stringify(args) + "\\n");
if (process.env.GH_TOKEN !== "wrapper-only-token") {
  console.error("plain gh did not receive wrapper authentication");
  process.exit(41);
}
if (args[0] !== "api" || args[1] !== "repos/openclaw/openclaw/actions/artifacts/${artifactId}/zip") {
  console.error("plain gh used for evidence read: " + args.join(" "));
  process.exit(42);
}
process.stdout.write(readFileSync(process.env.ARCHIVE));
`,
    );
    chmodSync(shimGh, 0o755);
    chmodSync(plainGh, 0o755);

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARCHIVE: archivePath,
        FIXTURES: fixturesPath,
        OPENCLAW_GH_BIN: plainGh,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        PLAIN_LOG: plainLog,
        SHIM_LOG: shimLog,
      };
      delete env.GH_ENTERPRISE_TOKEN;
      delete env.GITHUB_ENTERPRISE_TOKEN;
      delete env.GITHUB_TOKEN;
      delete env.GH_TOKEN;
      const lineageResult = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { createReleaseEvidenceClient } from ${JSON.stringify(pathToFileURL(resolve(SCRIPT)).href)};
           process.stdout.write(JSON.stringify(createReleaseEvidenceClient("openclaw/openclaw").compareCommitLineage("${workflowSha}", "${verifierSha}")));`,
        ],
        { encoding: "utf8", env },
      );
      expect(lineageResult.status).toBe(0);
      expect(JSON.parse(lineageResult.stdout)).toEqual({
        merge_base_commit: { sha: workflowSha },
        status: "ahead",
      });

      const result = spawnSync(process.execPath, [SCRIPT, runId], { encoding: "utf8", env });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `child: ${childRunId} OpenClaw Release Checks completed/failure`,
      );
      expect(result.stdout).toContain(
        "advisory: releaseChecksCandidate completed/failure cross_os_release_checks / Windows / packaged fresh",
      );
      expect(result.stdout).toContain(
        "advisory: releaseChecksCandidate completed/success cross_os_release_checks / macOS / packaged fresh",
      );
      expect(result.stdout).not.toContain(
        "advisory: releaseChecksCandidate completed/success cross_os_release_checks / Linux",
      );
      const shimCalls = readFileSync(shimLog, "utf8");
      const plainCalls = readFileSync(plainLog, "utf8");
      expect(shimCalls).toContain('"run","view"');
      expect(shimCalls).toContain('"auth","token"');
      expect(shimCalls).toContain(`"repos/openclaw/openclaw/actions/runs/${runId}"`);
      expect(shimCalls).toContain(
        `"repos/openclaw/openclaw/compare/${workflowSha}...${verifierSha}?per_page=1&page=2"`,
      );
      expect(shimCalls).toContain(
        JSON.stringify([
          "api",
          `repos/openclaw/openclaw/actions/jobs/${fixture.parentJob.id}/logs`,
          "--allow-escape-sequences",
        ]),
      );
      expect(shimCalls).not.toContain(`/actions/artifacts/${artifactId}/zip`);
      expect(plainCalls.trim()).toBe(
        JSON.stringify(["api", `repos/openclaw/openclaw/actions/artifacts/${artifactId}/zip`]),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function runParentJobLogProbe(shimBody: string) {
  const root = mkdtempSync(join(tmpdir(), "release-ci-job-log-"));
  const shimLog = join(root, "shim.log");
  const shimGh = join(root, "gh");
  writeFileSync(
    shimGh,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SHIM_LOG, JSON.stringify(args) + "\\n");
${shimBody}
`,
  );
  chmodSync(shimGh, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createReleaseEvidenceClient } from ${JSON.stringify(pathToFileURL(resolve(SCRIPT)).href)};
         try {
           process.stdout.write(await createReleaseEvidenceClient("owner/repo").getJobLog("123"));
         } catch (error) {
           process.stdout.write(JSON.stringify({
             message: error instanceof Error ? error.message : String(error),
             stderr: typeof error === "object" && error !== null && "stderr" in error
               ? String(error.stderr)
               : "",
           }));
           process.exitCode = 17;
         }`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          SHIM_LOG: shimLog,
        },
      },
    );
    return {
      calls: readFileSync(shimLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      result,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("parent job log compatibility", () => {
  const flaggedArgs = ["api", "repos/owner/repo/actions/jobs/123/logs", "--allow-escape-sequences"];
  const legacyArgs = ["api", "repos/owner/repo/actions/jobs/123/logs"];

  it("uses one flagged call when gh supports raw escape-sequence output", () => {
    const { calls, result } = runParentJobLogProbe(
      'process.stdout.write("\\u001b[31mlog\\u001b[0m");',
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("\u001b[31mlog\u001b[0m");
    expect(calls).toEqual([flaggedArgs]);
  });

  it("retries once without the flag for the exact legacy gh error", () => {
    const { calls, result } = runParentJobLogProbe(`
if (args.includes("--allow-escape-sequences")) {
  process.stderr.write("unknown flag: --allow-escape-sequences\\n\\nUsage: gh api <endpoint> [flags]\\n");
  process.exit(1);
}
process.stdout.write("\\u001b[31mlegacy log\\u001b[0m");
`);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("\u001b[31mlegacy log\u001b[0m");
    expect(calls).toEqual([flaggedArgs, legacyArgs]);
  });

  it("propagates unrelated errors without retrying", () => {
    const { calls, result } = runParentJobLogProbe(`
process.stderr.write("error: unknown flag: --allow-escape-sequences\\n");
process.exit(1);
`);

    expect(result.status).toBe(17);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Command failed: gh"),
        stderr: "error: unknown flag: --allow-escape-sequences\n",
      }),
    );
    expect(calls).toEqual([flaggedArgs]);
  });
});

describe("runReleaseCiGh", () => {
  it("bounds each GitHub lookup with a timeout and SIGKILL", () => {
    const execFileSyncImpl = vi.fn(() => "result");

    expect(
      runReleaseCiGh(["api", "repos/openclaw/openclaw/actions/runs/1"], { execFileSyncImpl }),
    ).toBe("result");
    expect(execFileSyncImpl).toHaveBeenCalledOnce();
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      expect.any(String),
      ["api", "repos/openclaw/openclaw/actions/runs/1"],
      expect.objectContaining({
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 60_000,
      }),
    );
  });

  it("propagates GitHub lookup timeouts", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(() =>
      runReleaseCiGh(["api", "rate_limit"], {
        execFileSyncImpl: () => {
          throw timeoutError;
        },
      }),
    ).toThrow(timeoutError);
  });
});

describe("Release execution plan artifact reads", () => {
  it("treats GitHub CLI 2.93 missing named artifacts as unavailable", () => {
    const root = tempDirs.make("release-plan-missing-artifact-");
    const ghPath = join(root, "gh");
    writeFileSync(
      ghPath,
      `#!${process.execPath}
console.error("no artifact matches any of the names or patterns provided");
process.exit(1);
`,
    );
    chmodSync(ghPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    try {
      expect(createReleaseEvidenceClient("openclaw/openclaw").loadExecutionPlan("123")).toBe(
        undefined,
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});

describe("Release Decision artifact polling", () => {
  const parent = { attempt: 1, headSha: "a".repeat(40) };

  it("treats GitHub CLI 2.93 missing named artifacts as unavailable", () => {
    expect(
      tryReadReleaseDecisionArtifact(parent, "123", "openclaw/openclaw", () => {
        throw Object.assign(
          new Error("no artifact matches any of the names or patterns provided"),
          {
            stderr: "no artifact matches any of the names or patterns provided",
          },
        );
      }),
    ).toBeUndefined();
  });

  it.each(["HTTP 503: Server Error", "HTTP 403: secondary rate limit"])(
    "treats transient download transport failure %s as unavailable this poll",
    (message) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          tryReadReleaseDecisionArtifact(parent, "123", "openclaw/openclaw", () => {
            throw Object.assign(new Error(message), { stderr: message });
          }),
        ).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("release decision artifact unavailable this poll"),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("keeps authentication and invocation failures hard", () => {
    for (const message of [
      "HTTP 401: Bad credentials",
      "unknown flag: --name\nUsage: gh run download",
    ]) {
      expect(() =>
        tryReadReleaseDecisionArtifact(parent, "123", "openclaw/openclaw", () => {
          throw Object.assign(new Error(message), { stderr: message });
        }),
      ).toThrow("release decision artifact read failed");
    }
  });
});

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeStoredZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentsBuffer = Buffer.from(contents, "utf8");
    const checksum = crc32(contentsBuffer);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(contentsBuffer.length),
      u32(contentsBuffer.length),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
    ]);
    localParts.push(localHeader, contentsBuffer);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(contentsBuffer.length),
        u32(contentsBuffer.length),
        u16(nameBuffer.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0),
        u32(offset),
        nameBuffer,
      ]),
    );
    offset += localHeader.length + contentsBuffer.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([
    localData,
    centralDirectory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(Object.keys(files).length),
    u16(Object.keys(files).length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0),
  ]);
}

function artifactDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rawManifest({
  candidateBinding,
  evidenceReuse,
  rerunGroup = "all",
  runId = "29090000000",
  targetSha = "a".repeat(40),
  version = 2,
  workflowFullRef,
  workflowRefType,
  workflowSha,
}: {
  candidateBinding?: unknown;
  evidenceReuse?: unknown;
  rerunGroup?: string;
  runId?: string;
  targetSha?: string;
  version?: 2 | 3;
  workflowFullRef?: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
}): {
  candidateBinding?: unknown;
  childRuns: Record<string, string | { blocking: boolean; conclusion: string; runId: string }>;
  controls: Record<string, unknown>;
  evidenceReuse?: unknown;
  releaseProfile: string;
  rerunGroup: string;
  runAttempt: string;
  runId: string;
  runReleaseSoak: string;
  targetRef?: string;
  targetSha: string;
  validationInputs: Record<string, string>;
  version: 2 | 3;
  workflowFullRef?: string;
  workflowName: string;
  workflowRef: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
} {
  return {
    ...(candidateBinding === undefined ? {} : { candidateBinding }),
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "202",
      productPerformance: { blocking: true, conclusion: "success", runId: "303" },
      releaseChecks: "404",
    },
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: false,
    },
    evidenceReuse,
    releaseProfile: "beta",
    rerunGroup,
    runAttempt: "2",
    runId,
    runReleaseSoak: "false",
    targetSha,
    validationInputs: {
      allowUnreleasedChangelog: "false",
      codexPluginSpec: "",
      crossOsSuiteFilter: "",
      liveSuiteFilter: "",
      mode: "direct",
      npmTelegramPackageSpec: "",
      npmTelegramProviderMode: "mock-openai",
      npmTelegramScenario: "",
      packageAcceptancePackageSpec: "",
      provider: "openai",
      releasePackageSpec: "",
      skipPackageTelegramE2e: "false",
      targetContextRef: "",
    },
    version,
    workflowName: "Full Release Validation",
    workflowRef: "main",
    ...(workflowSha ? { workflowSha } : {}),
    ...(version === 3
      ? {
          workflowFullRef: workflowFullRef ?? "refs/heads/main",
          workflowRefType: workflowRefType ?? "branch",
        }
      : {}),
  };
}

function trustedMainPackageFixture({
  manifestVersion = 2,
  parentPath = ".github/workflows/full-release-validation.yml",
  targetSha = "8".repeat(40),
  workflowFullRef,
  workflowRef = "main",
  workflowRefType,
  workflowSha = "0".repeat(40),
}: {
  manifestVersion?: 2 | 3;
  parentPath?: string;
  targetSha?: string;
  workflowFullRef?: string;
  workflowRef?: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
} = {}) {
  const runId = "29071366025";
  const childRunId = "29071382629";
  const manifest = rawManifest({
    rerunGroup: "package",
    runId,
    targetSha,
    version: manifestVersion,
    workflowFullRef,
    workflowRefType,
    workflowSha,
  });
  manifest.childRuns = {
    normalCi: "",
    npmTelegram: "",
    pluginPrerelease: "",
    productPerformance: { blocking: true, conclusion: "", runId: "" },
    releaseChecks: childRunId,
  };
  manifest.releaseProfile = "full";
  manifest.runAttempt = "1";
  manifest.runReleaseSoak = "true";
  manifest.workflowRef = workflowRef;

  const parentRun = {
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: workflowRef,
    head_sha: workflowSha,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
    id: Number(runId),
    path: parentPath,
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
  };
  const parentView = {
    attempt: 1,
    conclusion: "success",
    headBranch: workflowRef,
    headSha: workflowSha,
    jobs: [],
    status: "completed",
    url: parentRun.html_url,
  };
  const child = expectedChildDispatches(runId, 1, workflowRef).find(
    (entry) => entry.manifestKey === "releaseChecks",
  );
  if (!child) {
    throw new Error("missing release checks child fixture");
  }
  const parentJob = {
    completed_at: "2026-07-10T01:10:00Z",
    conclusion: "success",
    id: 86293408710,
    name: child.parentJobName,
    run_attempt: 1,
    started_at: "2026-07-10T01:00:00Z",
    status: "completed",
    steps: [],
  };
  const childRun = {
    actor: { login: "github-actions[bot]" },
    conclusion: "success",
    display_title: child.displayTitle,
    event: "workflow_dispatch",
    head_branch: workflowRef,
    head_sha: workflowSha,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${childRunId}`,
    id: Number(childRunId),
    path: ".github/workflows/openclaw-release-checks.yml",
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
    triggering_actor: { login: "github-actions[bot]" },
  };
  const artifact = {
    digest: `sha256:${"9".repeat(64)}`,
    expired: false,
    id: 8220114429,
    name: `full-release-validation-${runId}-1`,
    size_in_bytes: 507,
    workflow_run: {
      head_branch: workflowRef,
      head_sha: workflowSha,
      id: Number(runId),
    },
  };
  const compareCommits = (base: string, head: string) => {
    expect(base).toBe(workflowSha);
    return {
      merge_base_commit: { sha: workflowSha },
      status: base === head ? "identical" : "ahead",
    };
  };
  const client = {
    getWorkflowSource: (_sha: string) => "name: Full Release Validation\n",
    compareCommitLineage: compareCommits,
    compareCommits,
    getJobLog(jobId: number) {
      expect(jobId).toBe(parentJob.id);
      return [
        `TARGET_SHA: ${targetSha}`,
        `Dispatched openclaw-release-checks.yml: ${childRun.html_url} (attempt ${childRun.run_attempt})`,
      ].join("\n");
    },
    getParentJobs(requestedRunId: string) {
      expect(requestedRunId).toBe(runId);
      return [parentJob];
    },
    getRef(fullRef: string) {
      return { object: { sha: workflowSha }, ref: fullRef };
    },
    getRun(requestedRunId: string) {
      if (requestedRunId === runId) {
        return parentRun;
      }
      if (requestedRunId === childRunId) {
        return childRun;
      }
      throw new Error(`unexpected run: ${requestedRunId}`);
    },
    getRunView(requestedRunId: string) {
      expect(requestedRunId).toBe(runId);
      return parentView;
    },
    loadManifest(requestedRunId: string, requestedRunAttempt: number) {
      expect(requestedRunId).toBe(runId);
      expect(requestedRunAttempt).toBe(1);
      return { artifact, manifest };
    },
  };

  return {
    artifact,
    childRun,
    client,
    manifest,
    parentJob,
    parentRun,
    parentView,
    runId,
    targetSha,
    workflowSha,
  };
}

type ReleaseCiWatchState = {
  attempt: number;
  conclusion: string;
  jobs: Array<{ conclusion: string; name: string; status: string; url?: string }>;
  status: string;
  url?: string;
};

function trustedMainFullFixture() {
  const fixture = trustedMainPackageFixture({ manifestVersion: 3 });
  const children = expectedChildDispatches(fixture.runId, 1, "main", 3).filter(
    (child) => child.manifestKey !== "npmTelegram",
  );
  const runs = children.map((child, index) => ({
    ...fixture.childRun,
    display_title: child.displayTitle,
    id: 101 + index,
    path: `.github/workflows/${child.workflow}`,
  }));
  const jobs = children.map((child, index) => ({
    ...fixture.parentJob,
    id: 201 + index,
    name: child.parentJobName,
  }));
  const manifest = {
    ...fixture.manifest,
    childRuns: {
      ...fixture.manifest.childRuns,
      ...Object.fromEntries(
        children.map((child, index) => {
          const runId = String(expectDefined(runs[index], "child run").id);
          return [
            child.manifestKey,
            child.manifestKey === "productPerformance"
              ? { blocking: true, conclusion: "success", runId }
              : runId,
          ];
        }),
      ),
    },
    rerunGroup: "all",
    version: 4,
  };
  const client = {
    ...fixture.client,
    getJobLog: vi.fn((jobId: number) => {
      const index = jobs.findIndex((job) => job.id === jobId);
      const child = expectDefined(children[index], "dispatch child");
      const run = expectDefined(runs[index], "child run");
      return `TARGET_SHA: ${fixture.targetSha}\n-f publish_reports=false\nDispatched ${child.workflow}: https://github.com/openclaw/openclaw/actions/runs/${run.id} (attempt 1)`;
    }),
    getParentJobs: vi.fn((runId: string) =>
      runId === fixture.runId
        ? jobs
        : [{ ...fixture.parentJob, name: "Verify artifact-only report mode" }],
    ),
    getRun: vi.fn((runId: string) =>
      runId === fixture.runId
        ? fixture.parentRun
        : expectDefined(
            runs.find((run) => String(run.id) === runId),
            "child run",
          ),
    ),
    loadExecutionPlan: vi.fn(() => undefined),
    loadManifest: () => ({ artifact: fixture.artifact, manifest }),
  };
  return { ...fixture, client, manifest, runs };
}

function trustedMainNpmFixture(releaseProfile: "beta" | "stable" = "beta") {
  const fixture = trustedMainFullFixture();
  const beta = releaseProfile === "beta";
  const coveragePolicy = beta ? "npm-beta-v1" : "npm-stable-v1";
  const targetVersion = beta ? "2026.8.28-beta.1" : "2026.8.28";
  Object.assign(fixture.manifest, { releaseProfile, runReleaseSoak: String(!beta) });
  Object.assign(fixture.manifest.validationInputs, {
    coveragePolicy,
    skipPackageTelegramE2e: String(beta),
    targetContextRef: "release/2026.8.28",
    targetVersion,
  });
  fixture.manifest.controls.performanceBlocking = !beta;
  fixture.manifest.controls.stableSoakRequired = !beta;
  if (beta) {
    fixture.manifest.childRuns.productPerformance = { blocking: false, conclusion: "", runId: "" };
  }
  const plannedChildren = expectedChildDispatches(fixture.runId, 1, "main", 3).map((child) => {
    const run = fixture.runs.find((entry) => entry.display_title === child.displayTitle);
    const selected =
      child.manifestKey !== "npmTelegram" && !(beta && child.manifestKey === "productPerformance");
    return {
      displayTitle: child.displayTitle,
      key: child.manifestKey,
      required: selected,
      result: selected ? "success" : "skipped",
      runAttempt: selected ? 1 : null,
      runId: selected ? String(expectDefined(run, "selected child run").id) : "",
      selected,
      source: "fresh",
      url: selected ? expectDefined(run, "selected child run").html_url : "",
      workflow: child.workflow,
      workflowRef: "main",
      workflowSha: fixture.workflowSha,
    };
  });
  const executionPlan = buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 3,
    candidate: null,
    children: plannedChildren,
    coveragePolicy,
    evidenceReuse: { requested: false },
    expected: {
      candidateRequest: buildFullReleaseCandidateRequest({
        repository: "openclaw/openclaw",
        targetSha: fixture.targetSha,
        toolingSha: fixture.workflowSha,
        releaseProfile,
        releaseSoak: !beta,
        upgradeSurvivorBaseline: "openclaw@latest",
        upgradeSurvivorBaselines: "",
        upgradeSurvivorScenarios: "",
        allowFrozenTargetScenarioOmissions: false,
        allowUnreleasedChangelog: false,
        packagePublished: false,
        sharedImagePolicy: "no-push-artifact",
      }),
      parentRunAttempt: 1,
      parentRunId: fixture.runId,
      repository: "openclaw/openclaw",
      targetSha: fixture.targetSha,
      workflowRef: "main",
      workflowSha: fixture.workflowSha,
    },
    gates: [{ name: "Resolve target ref", required: true, result: "success" }],
    releaseProfile,
    rerunGroup: "all",
    targetVersion,
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: fixture.workflowSha },
  });
  const jobs = [{ ...fixture.parentJob, name: "test" }];
  const performanceJobs = [{ ...fixture.parentJob, name: "Verify artifact-only report mode" }];
  const jobsForChild = (key: string) => (key === "productPerformance" ? performanceJobs : jobs);
  const manifest = Object.assign(fixture.manifest, {
    childEvidence: Object.fromEntries(
      plannedChildren
        .filter((child) => child.selected)
        .map((child) => {
          const composite = composeReleaseAttemptJobs(
            [{ jobs: jobsForChild(child.key), runAttempt: 1 }],
            { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
          );
          return [
            child.key,
            {
              compositeJobsSha256: composite.sha256,
              dispatchActor: "github-actions[bot]",
              effectiveRunAttempt: 1,
              jobs: composite.jobs,
              observedRunAttempts: [1],
              plannedRunAttempt: 1,
              repository: "openclaw/openclaw",
              runId: child.runId,
              triggeringActor: "github-actions[bot]",
            },
          ];
        }),
    ),
    executionPlanSha256: executionPlan.sha256,
    sourceParentRunAttempt: 1,
  });
  const originalLog = fixture.client.getJobLog;
  const client = {
    ...fixture.client,
    getJobLog: vi.fn(
      (jobId: number) => `${originalLog(jobId)}\nCI_RELEASE_SCOPE: npm-${releaseProfile}`,
    ),
    getRunAttemptJobs: vi.fn((runId: string) =>
      jobsForChild(
        expectDefined(
          plannedChildren.find((child) => child.runId === runId),
          "child",
        ).key,
      ),
    ),
    loadExecutionPlan: vi.fn<() => ReleaseExecutionPlan | undefined>(() => executionPlan),
  };
  return { ...fixture, client, executionPlan, manifest };
}

function createReleaseCiWatchFixture(states: ReleaseCiWatchState[]) {
  const root = mkdtempSync(join(tmpdir(), "release-ci-watch-"));
  const callsPath = join(root, "calls.jsonl");
  const ghPath = join(root, "gh");
  const indexPath = join(root, "index.txt");
  const preloadPath = join(root, "immediate-timers.mjs");
  const fixture = trustedMainPackageFixture();
  const { runId } = fixture;
  const parent = { ...fixture.parentRun, conclusion: null, status: "in_progress" };
  const parentView = { ...fixture.parentView, conclusion: "", jobs: [], status: "in_progress" };
  writeFileSync(callsPath, "");
  writeFileSync(indexPath, "0");
  writeFileSync(
    ghPath,
    `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_CI_WATCH_CALLS, JSON.stringify(args) + "\\n");
const endpoint = args[1] ?? "";
const states = ${JSON.stringify(states)};
let output;
if (args[0] === "run" && args[1] === "view") {
  if (args[args.indexOf("--json") + 1] === "status,conclusion,attempt,headSha,jobs") {
    const index = Number(readFileSync(process.env.RELEASE_CI_WATCH_INDEX, "utf8"));
    output = { headSha: ${JSON.stringify(fixture.workflowSha)}, ...states[Math.min(index, states.length - 1)] };
    writeFileSync(process.env.RELEASE_CI_WATCH_INDEX, String(index + 1));
  } else output = ${JSON.stringify(parentView)};
} else if (args[0] === "run" && args[1] === "download") {
  const dir = args[args.indexOf("--dir") + 1];
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/full-release-decision.json", JSON.stringify({
    version: 2,
    kind: "openclaw.full-release-decision",
    mode: "decision",
    parentRunId: ${JSON.stringify(runId)},
    parentRunAttempt: 1,
    sourceParentRunAttempt: 1,
    workflowRef: "main",
    workflowSha: ${JSON.stringify(fixture.workflowSha)},
    targetSha: ${JSON.stringify(fixture.targetSha)},
    releaseProfile: "stable",
    rerunGroup: "all",
    executionPlanSha256: "${"d".repeat(64)}",
    state: "blocked_diagnostics_running",
    activeRunIds: ["101"],
    blockers: [{ child: "normalCi", job: "test", conclusion: "failure", runId: "101", url: "https://example.invalid/job" }],
    errors: [],
    cancellation: { requested: false, cancelledRunIds: [] },
    plan: [{ key: "normalCi", workflow: "ci.yml", displayTitle: "CI", dispatchName: "Dispatch CI", required: true, selected: true, source: "fresh", result: "success", runId: "101", runAttempt: 1, url: "https://example.invalid/run", workflowRef: "main", workflowSha: ${JSON.stringify(fixture.workflowSha)} }],
    children: {}
  }));
  process.exit(0);
} else if (endpoint === "rate_limit") output = { resources: { core: { limit: 5000, remaining: 4999, reset: 2_000_000_000 } } };
else if (endpoint === "repos/openclaw/openclaw/actions/runs/${runId}") output = ${JSON.stringify(parent)};
else if (endpoint.startsWith("repos/openclaw/openclaw/actions/runs/${runId}/artifacts?")) output = { artifacts: [] };
else { console.error("unexpected gh call: " + args.join(" ")); process.exit(43); }
process.stdout.write(JSON.stringify(output));
`,
  );
  writeFileSync(
    preloadPath,
    "globalThis.setTimeout = (callback, _delay, ...args) => { queueMicrotask(() => callback(...args)); return 0; };\n",
  );
  chmodSync(ghPath, 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    RELEASE_CI_WATCH_CALLS: callsPath,
    RELEASE_CI_WATCH_INDEX: indexPath,
  };
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    readCalls: (): string[][] =>
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    run: () =>
      spawnSync(
        process.execPath,
        ["--import", preloadPath, resolve(SCRIPT), runId, "--watch", "--interval", "1"],
        { encoding: "utf8", env, timeout: 20_000 },
      ),
    runId,
  };
}

describe("release CI summary child correlation", () => {
  it.each([
    { args: [], message: "full release run ID is required" },
    { args: ["29071366025", "--interval", "0"], message: "positive number of seconds" },
    { args: ["--validate-run", "29071366025", "--watch"], message: "cannot be combined" },
    { args: ["--manifest", "/tmp/manifest.json"], message: "requires --validate-run" },
    { args: ["123", "--reuse-request-json", "{}"], message: "requires --validate-run" },
    {
      args: ["--validate-run", "123", "--reuse-request-json", "null"],
      message: "reuse request is invalid",
    },
    {
      args: ["--validate-run", "123", "--reuse-request-json", "[]"],
      message: "reuse request is invalid",
    },
    {
      args: ["--validate-run", "29071366025", "--verifier-source-file", "/tmp/verifier.mjs"],
      message: "requires --verifier-source-sha",
    },
    {
      args: ["--validate-run", "29071366025", "--expected-run-attempts-json", "[]"],
      message: "requires a JSON object",
    },
    {
      args: ["--validate-run", "29071366025", "--expected-run-attempts-json", '{"29071366025":0}'],
      message: "must be a positive integer",
    },
    {
      args: [
        "--validate-run",
        "29071366025",
        "--expected-run-attempts-json",
        JSON.stringify(
          Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, 1])),
        ),
      ],
      message: "must contain 1-9 run IDs",
    },
    { args: ["--unknown"], message: "unknown or incomplete argument" },
  ])("rejects invalid CLI arguments before GitHub access: $message", ({ args, message }) => {
    const result = spawnSync(process.execPath, [resolve(SCRIPT), ...args], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: release-ci-summary.mjs");
    expect(result.stderr).toContain(message);
  });

  it("summarizes only visible watch transitions", () => {
    const jobs = [
      { conclusion: "", name: "Run normal full CI", status: "in_progress", url: "one" },
      { conclusion: "", name: "Run release checks", status: "queued", url: "two" },
    ];
    const fixture = createReleaseCiWatchFixture([
      { attempt: 1, conclusion: "", jobs, status: "queued", url: "first" },
      {
        attempt: 1,
        conclusion: "",
        jobs: jobs.toReversed().map((job) => Object.assign({}, job, { url: `${job.url}-changed` })),
        status: "queued",
        url: "changed",
      },
      {
        attempt: 1,
        conclusion: "",
        jobs: [{ conclusion: "success", name: "Run normal full CI", status: "completed" }],
        status: "in_progress",
      },
      {
        attempt: 1,
        conclusion: "success",
        jobs: [{ conclusion: "success", name: "Run normal full CI", status: "completed" }],
        status: "completed",
      },
    ]);
    try {
      const result = fixture.run();
      const calls = fixture.readCalls();
      const watchPolls = calls.filter(
        (args) =>
          args[0] === "run" &&
          args[args.indexOf("--json") + 1] === "status,conclusion,attempt,headSha,jobs",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(watchPolls).toHaveLength(4);
      expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(3);
    } finally {
      fixture.cleanup();
    }
  });

  it("summarizes before stopping on terminal parent job failures", () => {
    const failedJob = "Run release/live/Docker/QA validation";
    const fixture = createReleaseCiWatchFixture([
      {
        attempt: 1,
        conclusion: "",
        jobs: [
          { conclusion: "success", name: "success", status: "completed" },
          { conclusion: "neutral", name: "neutral", status: "completed" },
          { conclusion: "skipped", name: "skipped", status: "completed" },
          { conclusion: "", name: "running", status: "in_progress" },
          { conclusion: "failure", name: failedJob, status: "completed" },
        ],
        status: "in_progress",
      },
    ]);
    try {
      const result = fixture.run();
      const calls = fixture.readCalls();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(failedJob);
      expect(calls.filter((args) => args[0] === "run" && args[1] === "view")).toHaveLength(2);
      expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports an early release blocker once while the diagnostic drain continues", () => {
    const fixture = createReleaseCiWatchFixture([
      {
        attempt: 1,
        conclusion: "",
        jobs: [
          { conclusion: "failure", name: "Release Decision", status: "completed" },
          { conclusion: "", name: "Diagnostic Drain", status: "in_progress" },
        ],
        status: "in_progress",
      },
    ]);
    try {
      const result = fixture.run();
      const calls = fixture.readCalls();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Full Release Validation state: blocked_diagnostics_running");
      expect(result.stderr).toContain("Diagnostic Drain is still collecting terminal evidence");
      expect(
        calls.filter(
          (args) =>
            args[0] === "run" &&
            args[args.indexOf("--json") + 1] === "status,conclusion,attempt,headSha,jobs",
        ),
      ).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("selects one immutable manifest artifact bound to the exact parent run", () => {
    const { artifact, runId } = trustedMainPackageFixture();
    const legacyArtifact = {
      ...artifact,
      id: artifact.id + 1,
      name: `full-release-validation-${runId}`,
    };
    expect(selectManifestArtifact([artifact], runId, 1)).toBe(artifact);
    expect(selectManifestArtifact([legacyArtifact, artifact], runId, 1)).toBe(artifact);
    expect(selectManifestArtifact([legacyArtifact], runId, 1)).toBe(legacyArtifact);
    expect(validateManifestArtifactCompatibility(legacyArtifact, { version: 2 }, runId, 1)).toBe(
      legacyArtifact,
    );
    expect(
      selectManifestArtifact(
        [{ ...artifact, workflow_run: { ...artifact.workflow_run, id: 1 } }],
        runId,
        1,
      ),
    ).toBeUndefined();
    expect(() =>
      selectManifestArtifact([artifact, { ...artifact, id: artifact.id + 1 }], runId, 1),
    ).toThrow("multiple release validation manifest artifacts");
    expect(() =>
      selectManifestArtifact(
        [legacyArtifact, { ...legacyArtifact, id: legacyArtifact.id + 1 }],
        runId,
        1,
      ),
    ).toThrow("multiple legacy release validation manifest artifacts");
    expect(() => selectManifestArtifact([legacyArtifact], runId, 2)).toThrow(
      "legacy release validation manifest requires run attempt 1",
    );
    expect(() =>
      validateManifestArtifactCompatibility(legacyArtifact, { version: 3 }, runId, 1),
    ).toThrow("legacy release validation manifest artifact is not compatible");
    expect(selectManifestArtifact([artifact], runId, 2)).toBeUndefined();
    expect(() => selectManifestArtifact([{ ...artifact, digest: undefined }], runId, 1)).toThrow(
      "manifest artifact digest is invalid",
    );
    expect(() =>
      validateManifestArtifactIdentity(
        { ...artifact, digest: `sha256:${"8".repeat(64)}` },
        {
          artifactDigest: artifact.digest,
          artifactId: artifact.id,
          runAttempt: 1,
          runId,
        },
      ),
    ).toThrow("manifest artifact identity mismatch");
    expect(() =>
      validateManifestArtifactIdentity(
        { ...artifact, id: artifact.id + 1 },
        {
          artifactDigest: artifact.digest,
          artifactId: artifact.id,
          runAttempt: 1,
          runId,
        },
      ),
    ).toThrow("manifest artifact identity mismatch");

    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain("actions/artifacts/${artifactId}/zip");
    expect(source).toContain('"--name",');
    expect(source).toContain(
      "downloadParentManifestEvidence(runId, runAttempt, normalizedRepository, manifestPath)",
    );
  });

  it.skipIf(!hasUnzip)(
    "hashes and safely streams one bounded manifest entry from the exact artifact ZIP",
    () => {
      const root = mkdtempSync(join(tmpdir(), "release-manifest-artifact-"));
      try {
        const archivePath = join(root, "manifest.zip");
        const manifest = { runAttempt: 1, runId: "29071366025", evidence: "x".repeat(128 * 1024) };
        const archive = makeStoredZip({
          [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(manifest),
        });
        writeFileSync(archivePath, archive);
        expect(readManifestArtifactArchive(archivePath, artifactDigest(archive))).toEqual(manifest);
        expect(() => readManifestArtifactArchive(archivePath, `sha256:${"0".repeat(64)}`)).toThrow(
          "artifact digest mismatch",
        );

        const extraEntryArchive = makeStoredZip({
          [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(manifest),
          "unexpected.json": "{}",
        });
        writeFileSync(archivePath, extraEntryArchive);
        expect(() =>
          readManifestArtifactArchive(archivePath, artifactDigest(extraEntryArchive)),
        ).toThrow(`must contain only ${MANIFEST_ARTIFACT_ENTRY}`);

        const oversizedManifestArchive = makeStoredZip({
          [MANIFEST_ARTIFACT_ENTRY]: "x".repeat(MAX_RELEASE_ARTIFACT_BYTES + 1),
        });
        writeFileSync(archivePath, oversizedManifestArchive);
        expect(() =>
          readManifestArtifactArchive(archivePath, artifactDigest(oversizedManifestArchive)),
        ).toThrow("artifact entry size is invalid");

        const oversizedArchive = Buffer.alloc(MAX_RELEASE_ARTIFACT_BYTES + 8 * 1024 + 1);
        writeFileSync(archivePath, oversizedArchive);
        expect(() =>
          readManifestArtifactArchive(archivePath, artifactDigest(oversizedArchive)),
        ).toThrow("artifact compressed size is invalid");

        const source = readFileSync(SCRIPT, "utf8");
        expect(source).toContain('execFileSync("unzip", ["-p", archivePath');
        expect(source).not.toContain('execFileSync("unzip", ["-q", archivePath, "-d"');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("bridges only attempt-one manifest v2 artifacts with the legacy stable name", async () => {
    const legacyV2 = trustedMainPackageFixture();
    legacyV2.artifact.name = `full-release-validation-${legacyV2.runId}`;
    expect(
      (
        await validateReleaseRunEvidence(
          {
            repository: "openclaw/openclaw",
            runId: legacyV2.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          legacyV2.client,
        )
      ).root.artifact.name,
    ).toBe(legacyV2.artifact.name);

    const legacyV3 = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowSha: "a".repeat(40),
    });
    legacyV3.artifact.name = `full-release-validation-${legacyV3.runId}`;
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: legacyV3.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        legacyV3.client,
      ),
    ).rejects.toThrow("legacy release validation manifest artifact is not compatible");
  });

  it("normalizes a pre-tooling trusted-main producer separately from the current verifier", async () => {
    const fixture = trustedMainPackageFixture({
      targetSha: "8".repeat(40),
      workflowSha: "0".repeat(40),
    });
    const verifierSourceSha = "c".repeat(40);
    const evidence = await validateReleaseRunEvidence(
      {
        repository: "openclaw/openclaw",
        runId: fixture.runId,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha,
      },
      fixture.client,
    );

    expect(evidence).toMatchObject({
      directRoot: true,
      evidenceReuse: null,
      releaseProfile: "full",
      repository: "openclaw/openclaw",
      rerunGroup: "package",
      runReleaseSoak: true,
      schema: "openclaw.release-validation-evidence/v3",
      producerOnTrustedMainLineage: true,
      trustedWorkflowFullRef: "refs/heads/main",
      trustedWorkflowRef: "main",
      valid: true,
      verifier: {
        schemaVersion: 3,
        sourceSha: verifierSourceSha,
      },
    });
    expect(evidence.root).toMatchObject({
      manifestVersion: 2,
      runAttempt: 1,
      runId: fixture.runId,
      targetSha: fixture.targetSha,
      producerOnTrustedMainLineage: true,
      workflowFullRef: "refs/heads/main",
      workflowPath: ".github/workflows/full-release-validation.yml",
      workflowQualifiedPath: ".github/workflows/full-release-validation.yml@refs/heads/main",
      workflowRef: "main",
      workflowRefProof: "legacy-v2-main-ancestry",
      workflowRefType: "branch",
      workflowSha: fixture.workflowSha,
    });
    expect(evidence.root.workflowSha).not.toBe(evidence.root.targetSha);
    expect(evidence.verifier.sourceSha).not.toBe(evidence.root.workflowSha);
    expect(evidence.children).toEqual([
      expect.objectContaining({
        conclusion: "success",
        dispatchNonce: `full-release-validation-${fixture.runId}-1-release-checks`,
        headBranch: "main",
        role: "releaseChecks",
        runAttempt: 1,
        runId: String(fixture.childRun.id),
        sourceParentAttempt: 1,
        workflowSha: fixture.workflowSha,
      }),
    ]);
    expect(evidence.root.artifact).toEqual({
      digest: fixture.artifact.digest,
      id: String(fixture.artifact.id),
      name: fixture.artifact.name,
      runAttempt: 1,
      sizeInBytes: fixture.artifact.size_in_bytes,
    });
  });

  it("verifies all five selected children for sealed npm beta coverage", async () => {
    const fixture = trustedMainNpmFixture();
    const options = {
      runId: fixture.runId,
      verifierSourceContent: readFileSync(SCRIPT),
      verifierSourceSha: "c".repeat(40),
    };
    const evidence = await validateReleaseRunEvidence(options, fixture.client);
    expect(evidence.children.map((child: { role: string }) => child.role).toSorted()).toEqual([
      "normalCi",
      "pluginPrereleaseCandidate",
      "pluginPrereleaseIndependent",
      "releaseChecksCandidate",
      "releaseChecksIndependent",
    ]);
    expect(fixture.client.getRunAttemptJobs).toHaveBeenCalledTimes(5);
    expect(fixture.client.getJobLog).toHaveBeenCalledTimes(5);

    expectDefined(fixture.runs[0], "CI run").status = "in_progress";
    await expect(validateReleaseRunEvidence(options, fixture.client)).rejects.toThrow();
  });

  it("continues a failed npm producer through the real release evidence verifier", async () => {
    const fixture = trustedMainNpmFixture();
    const repository = "openclaw/openclaw";
    const producer = {
      ...fixture.parentRun,
      id: 81,
      head_repository: { full_name: repository },
      path: ".github/workflows/full-release-artifacts.yml",
      display_title: `Full Release Artifacts full-release-validation-${fixture.runId}-1-artifacts-npm`,
      conclusion: "failure",
    };
    const originalParent = {
      ...fixture.parentRun,
      display_title: "Full Release Validation",
      conclusion: "failure",
    };
    Object.assign(fixture.parentRun, originalParent);
    const resolveId = 901;
    const npmId = 902;
    const sourceJobs = fixture.client.getParentJobs(fixture.runId);
    const sourceLog = fixture.client.getJobLog;
    const getJobLog = async (id: number) => {
      if (id === resolveId) {
        return `RERUN_GROUP: all\nFAIL_FAST: false\nTARGET_SHA: ${fixture.targetSha}`;
      }
      if (id === npmId) {
        return `TARGET_SHA: ${fixture.targetSha}\nDispatched full-release-artifacts.yml: https://github.com/${repository}/actions/runs/81 (attempt 1)`;
      }
      return sourceLog(id);
    };
    const getRun = async (id: string) =>
      structuredClone(id === "81" ? producer : fixture.client.getRun(id));
    const rerunFailed = vi.fn(async (id: string) => {
      expect(id).toBe("81");
      producer.run_attempt = 2;
      producer.conclusion = "success";
    });
    const rerunParent = vi.fn(async () => {
      fixture.parentRun.run_attempt = 2;
      fixture.parentRun.conclusion = "success";
      fixture.parentView.attempt = 2;
      fixture.manifest.runAttempt = "2";
      fixture.artifact.name = `full-release-validation-${fixture.runId}-2`;
      fixture.client.getParentJobs.mockReturnValue([
        ...sourceJobs,
        ...sourceJobs.map((job) => ({
          ...job,
          id: job.id + 1000,
          run_attempt: 2,
          conclusion: "skipped",
          started_at: "2026-07-10T02:00:00Z",
          completed_at: "2026-07-10T02:01:00Z",
        })),
      ]);
    });
    const verify = vi.fn(
      async (
        runId: string,
        _plan: unknown,
        _deadline?: number,
        expectedRunAttempts?: Record<string, number>,
      ) =>
        validateReleaseRunEvidence(
          {
            runId,
            expectedRunAttempts,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          fixture.client,
        ),
    );
    await expect(
      continueFailed(fixture.executionPlan, fixture.runId, {
        repository,
        getRun,
        getRunAttempt: async (id: string) => (id === fixture.runId ? originalParent : getRun(id)),
        getAttemptJobs: async (id: string) => fixture.client.getRunAttemptJobs(id),
        getParentJobs: async () => [
          ...sourceJobs,
          ...[
            [resolveId, "Resolve target ref"],
            [npmId, "Prepare release npm artifacts"],
          ].map(([id, name]) => ({
            id,
            name,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          })),
        ],
        getJobLog,
        getReleaseEvidenceClient: () => ({
          ...createReleaseEvidenceClient(repository),
          getWorkflowSource: () => "node scripts/full-release-artifacts.mjs resolve",
        }),
        rerunFailed,
        rerunParent,
        verify,
      }),
    ).resolves.toMatchObject({ action: "reran-parent" });
    expect(rerunFailed).toHaveBeenCalledExactlyOnceWith("81");
    expect(rerunParent).toHaveBeenCalledExactlyOnceWith(fixture.runId);
    expect((await verify.mock.results[0]!.value).children).toHaveLength(5);
  });

  it.each(["complete", "deleted-manifest", "deleted-plan", "changed-plan", "deleted-publication"])(
    "verifies source admission against the immutable workflow and plan: %s",
    async (mutation) => {
      const fixture = trustedMainNpmFixture();
      const inputs = fixture.manifest.validationInputs;
      const sourceAdmission = createPublicationSourceFact(
        publicationSourceRequest({
          PUBLICATION_INPUTS_JSON: JSON.stringify({
            ref: fixture.targetSha,
            trusted_workflow_json: publicationDispatchEnvelope(null, {
              validationPurpose: "publish",
              publicationSelection: {
                route: "normal",
                npmDistTag: "beta",
                publishOpenclawNpm: true,
                pluginPublishScope: "all-publishable",
                plugins: [],
              },
            }),
            release_profile: "beta",
            rerun_group: "all",
            provider: inputs.provider,
            mode: inputs.mode,
            npm_telegram_provider_mode: inputs.npmTelegramProviderMode,
            skip_package_telegram_e2e: inputs.skipPackageTelegramE2e,
          }),
          PUBLICATION_TARGET_CONTEXT: inputs.targetContextRef,
          PUBLICATION_COVERAGE_POLICY: inputs.coveragePolicy,
          PUBLICATION_TOOLING_JSON: JSON.stringify({
            fullRef: "refs/heads/main",
            sha: fixture.workflowSha,
          }),
          PUBLICATION_TARGET_SHA: fixture.targetSha,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: fixture.workflowSha,
          GITHUB_RUN_ID: fixture.runId,
          GITHUB_RUN_ATTEMPT: "1",
        }),
        { packages: [], platforms: [] },
        {
          version: expectDefined(inputs.targetVersion, "target version"),
          packages: [{ name: "openclaw", version: inputs.targetVersion, targets: ["npm"] }],
          platforms: [],
        },
      );
      Object.assign(fixture.executionPlan, { sourceAdmissionContract: "1", sourceAdmission });
      fixture.executionPlan.sha256 = releaseExecutionPlanSha256(fixture.executionPlan);
      const manifest = Object.assign(fixture.manifest, {
        sourceAdmissionContract: "1",
        sourceAdmission,
        trustedWorkflow: fixture.executionPlan.trustedWorkflow,
        executionPlanSha256: fixture.executionPlan.sha256,
      });
      Object.assign(inputs, publicationIntentInputs(sourceAdmission));
      const client = {
        ...fixture.client,
        getWorkflowSource: vi.fn((sha: string) => {
          expect(sha).toBe(fixture.workflowSha);
          return (
            'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n' +
            (mutation === "deleted-publication"
              ? '  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n'
              : "")
          );
        }),
      };
      if (mutation === "deleted-manifest") {
        Reflect.deleteProperty(manifest, "sourceAdmission");
        Reflect.deleteProperty(manifest, "sourceAdmissionContract");
        Reflect.deleteProperty(inputs, "validationPurpose");
        Reflect.deleteProperty(inputs, "publicationSelectionJson");
      } else if (mutation === "deleted-plan") {
        delete fixture.executionPlan.sourceAdmission;
        delete fixture.executionPlan.sourceAdmissionContract;
        fixture.executionPlan.sha256 = releaseExecutionPlanSha256(fixture.executionPlan);
        manifest.executionPlanSha256 = fixture.executionPlan.sha256;
      } else if (mutation === "changed-plan") {
        const { digest: _digest, ...changed } = sourceAdmission;
        changed.publicationSelection = {
          ...expectDefined(sourceAdmission.publicationSelection, "publication selection"),
          route: "prepared",
        };
        fixture.executionPlan.sourceAdmission = {
          ...changed,
          digest: createHash("sha256").update(publicationSourceJson(changed)).digest("hex"),
        };
        fixture.executionPlan.sha256 = releaseExecutionPlanSha256(fixture.executionPlan);
        manifest.executionPlanSha256 = fixture.executionPlan.sha256;
      }
      const result = validateReleaseRunEvidence(
        {
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        client,
      );
      if (mutation === "complete") {
        expect((await result).children).toHaveLength(5);
        expect(client.getWorkflowSource).toHaveBeenCalledTimes(1);
        expect(client.loadExecutionPlan).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toThrow(/source admission|publication/u);
      }
    },
  );

  it("authenticates a rejected automatic retry after a manual repair in the strict summary", async () => {
    const fixture = trustedMainNpmFixture();
    const plannedChild = expectDefined(
      fixture.executionPlan.children.find((child) => child.key === "normalCi"),
      "normal CI plan",
    );
    const childRun = expectDefined(
      fixture.runs.find((run) => String(run.id) === plannedChild.runId),
      "normal CI run",
    );
    const originalRun = { ...childRun, conclusion: "failure" };
    const originalParent = { ...fixture.parentRun, conclusion: "failure" };
    const originalJob = {
      ...fixture.parentJob,
      id: 501,
      name: "test",
      conclusion: "failure",
    };
    const repairedJob = { ...originalJob, id: 502, run_attempt: 2, conclusion: "success" };
    const knownFlakyJobs = ["normalCi:test"];
    Object.assign(fixture.executionPlan, { knownFlakyJobs });
    fixture.executionPlan.sha256 = releaseExecutionPlanSha256(fixture.executionPlan);
    const intent = expectDefined(
      selectReleaseFlakeIntent(fixture.executionPlan, plannedChild, originalRun, [originalJob]),
      "automatic retry intent",
    );
    const composite = composeReleaseAttemptJobs(
      [
        { jobs: [originalJob], runAttempt: 1 },
        { jobs: [repairedJob], runAttempt: 2 },
      ],
      { effectiveRunAttempt: 2, plannedRunAttempt: 1 },
    );
    childRun.run_attempt = 2;
    childRun.triggering_actor = { login: "release-operator" };
    Object.assign(expectDefined(fixture.manifest.childEvidence.normalCi, "normal CI evidence"), {
      compositeJobsSha256: composite.sha256,
      effectiveRunAttempt: 2,
      jobs: composite.jobs,
      observedRunAttempts: [1, 2],
      triggeringActor: "release-operator",
    });
    Object.assign(fixture.manifest, {
      knownFlakyJobs,
      executionPlanSha256: fixture.executionPlan.sha256,
      automaticRetries: [
        {
          child: "normalCi",
          executionPlanSha256: fixture.executionPlan.sha256,
          intent,
          outcome: "rejected",
          replacements: [],
        },
      ],
    });
    fixture.manifest.validationInputs.knownFlakyJobsJson = JSON.stringify(knownFlakyJobs);
    fixture.manifest.runAttempt = "2";
    fixture.parentRun.run_attempt = 2;
    fixture.parentView.attempt = 2;
    fixture.artifact.name = `full-release-validation-${fixture.runId}-2`;
    const owner = {
      id: 900,
      name: "Automatic retry (normalCi)",
      status: "completed",
      steps: [
        {
          name: "Upload automatic retry intent",
          status: "completed",
          conclusion: "success",
          number: 1,
          started_at: "2026-07-10T01:10:01Z",
          completed_at: "2026-07-10T01:10:02Z",
        },
        {
          name: "Record automatic retry intent digest",
          status: "completed",
          conclusion: "success",
          number: 2,
          started_at: "2026-07-10T01:10:02Z",
          completed_at: "2026-07-10T01:10:03Z",
        },
        {
          name: "Execute automatic retry",
          status: "completed",
          conclusion: "failure",
          number: 3,
          started_at: "2026-07-10T01:10:03Z",
          completed_at: "2026-07-10T01:10:04Z",
        },
        {
          name: "Record automatic retry rejection digest",
          status: "completed",
          conclusion: "success",
          number: 4,
          started_at: "2026-07-10T01:10:04Z",
          completed_at: "2026-07-10T01:10:05Z",
        },
      ],
    };
    const intentDigest = releaseFlakeIntentSha256(intent);
    let rejectionDigest = intentDigest;
    const client = {
      ...fixture.client,
      getParentJobs: (runId: string) => {
        const jobs = fixture.client.getParentJobs(runId);
        return runId === fixture.runId
          ? jobs.flatMap((job) => [
              job,
              { ...job, id: job.id + 1000, run_attempt: 2, conclusion: "skipped" },
            ])
          : jobs;
      },
      getRunAttempt: (runId: string, attempt: number) => {
        expect(attempt).toBe(1);
        if (runId === fixture.runId) {
          return originalParent;
        }
        expect(runId).toBe(plannedChild.runId);
        return originalRun;
      },
      getRunAttemptJobs: (runId: string, attempt: number) => {
        if (runId === fixture.runId) {
          expect(attempt).toBe(1);
          return [owner];
        }
        if (runId === plannedChild.runId) {
          return attempt === 1 ? [originalJob] : [repairedJob];
        }
        return fixture.client.getRunAttemptJobs(runId);
      },
      getJobLog: (jobId: number) =>
        jobId === owner.id
          ? `2026-07-10T01:10:02.500Z FRV_AUTO_RETRY_INTENT_SHA256=${intentDigest}\n2026-07-10T01:10:04.500Z FRV_AUTO_RETRY_REJECTED_INTENT_SHA256=${rejectionDigest}\n`
          : fixture.client.getJobLog(jobId),
    };
    const options = {
      runId: fixture.runId,
      verifierSourceContent: readFileSync(SCRIPT),
      verifierSourceSha: "c".repeat(40),
    };
    const evidence = await validateReleaseRunEvidence(options, client);
    expect(evidence.valid).toBe(true);
    expect(evidence.children).toContainEqual(
      expect.objectContaining({ role: "normalCi", plannedRunAttempt: 1, runAttempt: 2 }),
    );
    rejectionDigest = "f".repeat(64);
    await expect(validateReleaseRunEvidence(options, client)).rejects.toThrow(
      "automatic retry rejection is not bound to its original owner witness",
    );
  });

  it("retains blocking product performance in sealed npm stable evidence", async () => {
    const fixture = trustedMainNpmFixture("stable");
    const options = {
      runId: fixture.runId,
      verifierSourceContent: readFileSync(SCRIPT),
      verifierSourceSha: "c".repeat(40),
    };
    const evidence = await validateReleaseRunEvidence(options, fixture.client);
    expect(evidence.children.map((child: { role: string }) => child.role).toSorted()).toEqual([
      "normalCi",
      "pluginPrereleaseCandidate",
      "pluginPrereleaseIndependent",
      "productPerformance",
      "releaseChecksCandidate",
      "releaseChecksIndependent",
    ]);
    expect(evidence.runReleaseSoak).toBe(true);
    expect(fixture.client.getRunAttemptJobs).toHaveBeenCalledTimes(6);
    const performance = expectDefined(
      fixture.runs.find((run) => run.path === ".github/workflows/openclaw-performance.yml"),
      "performance child",
    );
    performance.conclusion = "failure";
    await expect(validateReleaseRunEvidence(options, fixture.client)).rejects.toThrow();
  });

  it.each(["carried-guard", "newer-guard-failure", "earlier-publisher"])(
    "verifies effective artifact-only performance evidence after a targeted retry: %s",
    async (scenario) => {
      const fixture = trustedMainNpmFixture("stable");
      const performance = expectDefined(
        fixture.runs.find((run) => run.path === ".github/workflows/openclaw-performance.yml"),
        "performance child",
      );
      const runId = String(performance.id);
      const guard = { ...fixture.parentJob, name: "Verify artifact-only report mode" };
      const benchmark = { ...fixture.parentJob, name: "Run performance benchmark" };
      const originalJobs = [
        guard,
        { ...benchmark, conclusion: "failure" },
        {
          ...fixture.parentJob,
          name: "Publish mock provider report",
          conclusion: scenario === "earlier-publisher" ? "success" : "skipped",
        },
      ];
      const retryJobs = [
        { ...benchmark, run_attempt: 2 },
        ...(scenario === "newer-guard-failure"
          ? [{ ...guard, conclusion: "failure", run_attempt: 2 }]
          : []),
      ];
      const composite = composeReleaseAttemptJobs(
        [
          { jobs: originalJobs, runAttempt: 1 },
          { jobs: retryJobs, runAttempt: 2 },
        ],
        { effectiveRunAttempt: 2, plannedRunAttempt: 1 },
      );
      Object.assign(performance, {
        run_attempt: 2,
        triggering_actor: { login: "release-maintainer" },
      });
      Object.assign(
        expectDefined(fixture.manifest.childEvidence.productPerformance, "performance evidence"),
        {
          compositeJobsSha256: composite.sha256,
          effectiveRunAttempt: 2,
          jobs: composite.jobs,
          observedRunAttempts: [1, 2],
          triggeringActor: performance.triggering_actor.login,
        },
      );
      const getOriginalJobs = fixture.client.getRunAttemptJobs;
      const result = validateReleaseRunEvidence(
        {
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        {
          ...fixture.client,
          getRunAttemptJobs: (childRunId: string, runAttempt: number) =>
            childRunId === runId
              ? runAttempt === 1
                ? originalJobs
                : retryJobs
              : getOriginalJobs(childRunId),
        },
      );
      if (scenario === "carried-guard") {
        expect((await result).children).toContainEqual(
          expect.objectContaining({
            reportPublication: "artifact-only",
            role: "productPerformance",
            runAttempt: 2,
          }),
        );
      } else {
        await expect(result).rejects.toThrow(
          scenario === "newer-guard-failure"
            ? "performance artifact-only guard is missing or unsuccessful"
            : "performance report publisher was not skipped",
        );
      }
    },
  );

  it.each(["context", "blocking-performance", "soak-control", "soak", "missing-plan"])(
    "rejects incomplete npm stable qualification: %s",
    async (drift) => {
      const fixture = trustedMainNpmFixture("stable");
      if (drift === "context") {
        fixture.manifest.validationInputs.targetContextRef = "";
      } else if (drift === "blocking-performance") {
        fixture.manifest.controls.performanceBlocking = false;
      } else if (drift === "soak-control") {
        fixture.manifest.controls.stableSoakRequired = false;
      } else if (drift === "soak") {
        fixture.manifest.runReleaseSoak = "false";
      } else {
        fixture.client.loadExecutionPlan.mockReturnValue(undefined);
      }
      await expect(
        validateReleaseRunEvidence(
          {
            runId: fixture.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          fixture.client,
        ),
      ).rejects.toThrow();
    },
  );

  it.each([
    "missing-plan",
    "missing-marker",
    "wrong-target-version",
    "full-ci",
    "deferred-run",
    "package-telegram",
  ])("rejects npm beta coverage drift: %s", async (drift) => {
    const fixture = trustedMainNpmFixture();
    if (drift === "missing-plan") {
      fixture.client.loadExecutionPlan.mockReturnValue(undefined);
    } else if (drift === "missing-marker") {
      delete fixture.manifest.validationInputs.coveragePolicy;
    } else if (drift === "wrong-target-version") {
      fixture.manifest.validationInputs.targetVersion = "2026.8.28-beta.2";
    } else if (drift === "full-ci") {
      fixture.client.getJobLog.mockImplementation(
        (jobId: number) =>
          `TARGET_SHA: ${fixture.targetSha}\nCI_RELEASE_SCOPE: full\nDispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/${jobId - 100} (attempt 1)`,
      );
    } else if (drift === "package-telegram") {
      fixture.manifest.validationInputs.skipPackageTelegramE2e = "false";
    } else {
      fixture.manifest.childRuns.productPerformance = {
        blocking: false,
        conclusion: "success",
        runId: "106",
      };
    }
    await expect(
      validateReleaseRunEvidence(
        {
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow();
  });

  it.each([
    "version",
    "reused",
    "group",
    "profile",
    "soak",
    "inputs",
    "coverage",
    "stable-coverage",
    "target-context",
    "target",
  ])("rejects an ineligible reuse %s before fetching child evidence", async (mismatch) => {
    const fixture = trustedMainFullFixture();
    const reuseRequest = {
      releaseProfile: "full",
      runReleaseSoak: "true",
      targetSha: fixture.targetSha,
      validationInputs: { ...fixture.manifest.validationInputs },
    };
    switch (mismatch) {
      case "version":
        fixture.manifest.version = 3;
        break;
      case "reused":
        fixture.manifest.evidenceReuse = {
          changedPaths: [],
          evidenceSha: fixture.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: "29090000000",
          selectedRunId: "29090000000",
        };
        break;
      case "group":
        fixture.manifest.rerunGroup = "package";
        break;
      case "profile":
        reuseRequest.releaseProfile = "beta";
        break;
      case "soak":
        reuseRequest.runReleaseSoak = "false";
        break;
      case "inputs":
        reuseRequest.validationInputs.provider = "anthropic";
        break;
      case "coverage":
        reuseRequest.validationInputs.coveragePolicy = "npm-beta-v1";
        break;
      case "stable-coverage":
        reuseRequest.validationInputs.coveragePolicy = "npm-stable-v1";
        break;
      case "target-context":
        reuseRequest.validationInputs.targetContextRef = "release/2026.8.28-1";
        break;
      case "target":
        reuseRequest.targetSha = "7".repeat(40);
        fixture.client.compareCommits = () => ({
          files: [{ filename: "src/index.ts", status: "modified" }],
          merge_base_commit: { sha: fixture.targetSha },
          status: "ahead",
        });
    }
    await expect(
      validateReleaseRunEvidence(
        {
          reuseRequest,
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow(
      mismatch === "target" ? "failed commit comparison" : "ineligible reuse candidate",
    );
    expect(fixture.client.getRun).toHaveBeenCalledExactlyOnceWith(fixture.runId);
    expect(fixture.client.loadExecutionPlan).not.toHaveBeenCalled();
    expect(fixture.client.getParentJobs).not.toHaveBeenCalled();
    expect(fixture.client.getJobLog).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "collects independent child evidence concurrently and drains reads (failure=%s)",
    async (failure) => {
      const fixture = trustedMainFullFixture();
      let active = 0;
      let peak = 0;
      let completed = 0;
      const client = {
        ...fixture.client,
        async getJobLog(jobId: number) {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((complete) => {
            setImmediate(complete);
          });
          active -= 1;
          completed += 1;
          if (failure && jobId === 201) {
            throw new Error("dispatch log unavailable");
          }
          return fixture.client.getJobLog(jobId);
        },
      };
      const validation = Promise.resolve().then(() =>
        validateReleaseRunEvidence(
          {
            runId: fixture.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          client,
        ),
      );
      if (failure) {
        await expect(validation).rejects.toThrow("dispatch log unavailable");
      } else {
        await expect(validation).resolves.toMatchObject({ valid: true });
      }
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(7);
      expect(completed).toBe(6);
      expect(active).toBe(0);
    },
  );

  it.each([false, true])(
    "retains full child proof for eligible reuse (changelog=%s)",
    async (changelog) => {
      const fixture = trustedMainFullFixture();
      fixture.client.compareCommits = () => ({
        files: [{ filename: "CHANGELOG.md", status: "modified" }],
        merge_base_commit: { sha: fixture.targetSha },
        status: "ahead",
      });
      const options = {
        reuseRequest: {
          releaseProfile: fixture.manifest.releaseProfile,
          runReleaseSoak: fixture.manifest.runReleaseSoak,
          targetSha: changelog ? "7".repeat(40) : fixture.targetSha,
          validationInputs: { ...fixture.manifest.validationInputs },
        },
        runId: fixture.runId,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha: "c".repeat(40),
      };
      const evidence = await validateReleaseRunEvidence(options, fixture.client);
      expect(evidence.valid).toBe(true);
      expect(evidence.children).toHaveLength(6);
      expect(fixture.client.getJobLog).toHaveBeenCalledTimes(6);

      expectDefined(fixture.runs[0], "CI run").head_sha = "f".repeat(40);
      await expect(validateReleaseRunEvidence(options, fixture.client)).rejects.toThrow(
        "manifest child dispatch tuple mismatch",
      );
    },
  );

  it.each(["", "2026.8.1", "2026.9.1"])(
    "recomputes mixed-attempt evidence with Telegram waiver %j",
    async (version) => {
      const fixture = trustedMainPackageFixture({
        manifestVersion: 3,
        workflowSha: "a".repeat(40),
      });
      const manifest = fixture.manifest as typeof fixture.manifest & {
        childEvidence: Record<
          string,
          {
            compositeJobsSha256: string;
            effectiveRunAttempt: number;
            jobs: Array<{
              acceptedRunAttempt: number;
              completedAt: string;
              conclusion: string;
              name: string;
              startedAt: string;
              status: string;
              url: string;
            }>;
            observedRunAttempts: number[];
            plannedRunAttempt: number;
            runId: string;
          }
        >;
        executionPlanSha256: string;
        sourceParentRunAttempt: number;
      };
      const client = fixture.client as typeof fixture.client & {
        getRunAttemptJobs: (runId: string, runAttempt: number) => Array<Record<string, unknown>>;
        loadExecutionPlan: () => Record<string, unknown>;
      };
      const waiver = version
        ? { telegramWaiver: `${version}-owner-approved`, targetVersion: version }
        : {};
      Object.assign(manifest.validationInputs, waiver);
      const plannedChild = {
        dispatchName: "Dispatch release checks",
        displayTitle: fixture.childRun.display_title,
        key: "releaseChecks",
        required: true,
        result: "success",
        runAttempt: 1,
        runId: String(fixture.childRun.id),
        selected: true,
        source: "fresh",
        url: fixture.childRun.html_url,
        workflow: "openclaw-release-checks.yml",
        workflowRef: fixture.childRun.head_branch,
        workflowSha: fixture.childRun.head_sha,
      };
      const executionPlan = buildReleaseExecutionPlanArtifact({
        ...waiver,
        attemptEvidenceVersion: 2,
        candidate: null,
        children: [plannedChild],
        evidenceReuse: { requested: false },
        expected: {
          candidateRequest: buildFullReleaseCandidateRequest({
            repository: "openclaw/openclaw",
            targetSha: fixture.targetSha,
            toolingSha: fixture.workflowSha,
            releaseProfile: "full",
            releaseSoak: true,
            upgradeSurvivorBaseline: "openclaw@latest",
            upgradeSurvivorBaselines: "",
            upgradeSurvivorScenarios: "reported-issues",
            allowFrozenTargetScenarioOmissions: false,
            allowUnreleasedChangelog: false,
            packagePublished: false,
            sharedImagePolicy: "no-push-artifact",
          }),
          parentRunAttempt: 1,
          parentRunId: fixture.runId,
          repository: "openclaw/openclaw",
          targetSha: fixture.targetSha,
          workflowRef: fixture.parentRun.head_branch,
          workflowSha: fixture.workflowSha,
        },
        gates: [{ name: "Resolve target ref", required: true, result: "success" }],
        releaseProfile: "full",
        rerunGroup: "package",
        trustedWorkflow: {
          fullRef: "refs/heads/main",
          ref: "main",
          sha: fixture.workflowSha,
        },
      });
      expect(executionPlan.candidate).toBeNull();
      fixture.childRun.run_attempt = 2;
      fixture.childRun.triggering_actor = { login: "release-operator" };
      const firstAttemptJob = {
        completed_at: "2026-08-22T00:01:00Z",
        conclusion: "failure",
        html_url: "https://example.invalid/jobs/test",
        name: "test",
        started_at: "2026-08-22T00:00:00Z",
        status: "completed",
      };
      const secondAttemptJob = { ...firstAttemptJob, conclusion: "success" };
      const compositeJobs = [
        {
          acceptedRunAttempt: 2,
          completedAt: secondAttemptJob.completed_at,
          conclusion: "success",
          name: "test",
          startedAt: secondAttemptJob.started_at,
          status: "completed",
          url: secondAttemptJob.html_url,
        },
      ];
      const releaseChecksEvidence = {
        compositeJobsSha256: releaseCompositeJobsSha256({
          effectiveRunAttempt: 2,
          jobs: compositeJobs,
          plannedRunAttempt: 1,
        }),
        dispatchActor: "github-actions[bot]",
        effectiveRunAttempt: 2,
        jobs: compositeJobs,
        observedRunAttempts: [1, 2],
        plannedRunAttempt: 1,
        repository: "openclaw/openclaw",
        runId: String(fixture.childRun.id),
        triggeringActor: "release-operator",
      };
      manifest.executionPlanSha256 = String(executionPlan.sha256);
      manifest.sourceParentRunAttempt = 1;
      manifest.runAttempt = "2";
      manifest.childEvidence = {
        releaseChecks: releaseChecksEvidence,
      };
      fixture.parentRun.run_attempt = 2;
      fixture.parentView.attempt = 2;
      fixture.artifact.name = `full-release-validation-${fixture.runId}-2`;
      const skippedParentJob = {
        completed_at: "2026-08-22T00:02:00Z",
        conclusion: "skipped",
        id: fixture.parentJob.id + 1,
        name: fixture.parentJob.name,
        run_attempt: 2,
        started_at: "2026-08-22T00:02:00Z",
        status: "completed",
        steps: [],
      };
      client.loadExecutionPlan = () => executionPlan;
      client.loadManifest = (requestedRunId: string, requestedRunAttempt: number) => {
        expect(requestedRunId).toBe(fixture.runId);
        expect(requestedRunAttempt).toBe(2);
        return { artifact: fixture.artifact, manifest };
      };
      client.getParentJobs = (requestedRunId: string) => {
        expect(requestedRunId).toBe(fixture.runId);
        return [fixture.parentJob, skippedParentJob];
      };
      client.getRunAttemptJobs = (_runId: string, attempt: number) =>
        attempt === 1 ? [firstAttemptJob] : [secondAttemptJob];
      fixture.client.getJobLog = (jobId: number) => {
        expect(jobId).toBe(fixture.parentJob.id);
        return [
          `TARGET_SHA: ${fixture.targetSha}`,
          `Dispatched openclaw-release-checks.yml: ${fixture.childRun.html_url} (attempt 1)`,
        ].join("\n");
      };

      const validate = (expectedRunAttempts?: Record<string, number>) =>
        validateReleaseRunEvidence(
          {
            expectedRunAttempts,
            repository: "openclaw/openclaw",
            runId: fixture.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          fixture.client,
        );
      const evidence = await validate();
      expect(evidence.children).toEqual([
        expect.objectContaining({
          compositeJobsSha256: releaseChecksEvidence.compositeJobsSha256,
          plannedRunAttempt: 1,
          runAttempt: 2,
        }),
      ]);
      if (version) {
        delete manifest.validationInputs.telegramWaiver;
        await expect(validate()).rejects.toThrow(/Telegram waiver/u);
        Object.assign(manifest.validationInputs, waiver);
        client.loadExecutionPlan = () => undefined as never;
        await expect(validate()).rejects.toThrow(/Telegram waiver/u);
        client.loadExecutionPlan = () => executionPlan;
      }

      for (const [expectedRunAttempts, message] of [
        [{ [fixture.runId]: 1, [String(fixture.childRun.id)]: 2 }, "parent run attempt changed"],
        [{ [fixture.runId]: 2, [String(fixture.childRun.id)]: 1 }, "child run attempt changed"],
        [{ [fixture.runId]: 2 }, "expected run attempts omitted"],
        [{ [fixture.runId]: 2, [String(fixture.childRun.id)]: 2, "999": 1 }, "unvalidated run IDs"],
      ] as const) {
        await expect(validate(expectedRunAttempts)).rejects.toThrow(message);
      }

      const staleJobs = [
        {
          acceptedRunAttempt: 1,
          completedAt: firstAttemptJob.completed_at,
          conclusion: firstAttemptJob.conclusion,
          name: firstAttemptJob.name,
          startedAt: firstAttemptJob.started_at,
          status: firstAttemptJob.status,
          url: firstAttemptJob.html_url,
        },
      ];
      const staleEvidence = {
        compositeJobsSha256: releaseCompositeJobsSha256({
          effectiveRunAttempt: 1,
          jobs: staleJobs,
          plannedRunAttempt: 1,
        }),
        dispatchActor: "github-actions[bot]",
        effectiveRunAttempt: 1,
        jobs: staleJobs,
        observedRunAttempts: [1],
        plannedRunAttempt: 1,
        repository: "openclaw/openclaw",
        runId: String(fixture.childRun.id),
        triggeringActor: "github-actions[bot]",
      };
      manifest.childEvidence.releaseChecks = staleEvidence;
      await expect(
        validate({ [fixture.runId]: 2, [String(fixture.childRun.id)]: 2 }),
      ).rejects.toThrowError(
        expect.objectContaining({
          message: "successful parent manifest predates OpenClaw Release Checks attempt 2",
          refreshable: true,
        }),
      );

      manifest.childEvidence.releaseChecks = releaseChecksEvidence;
      const loadManifest = client.loadManifest.bind(client);
      client.loadManifest = () => undefined as never;
      await expect(
        validate({ [fixture.runId]: 2, [String(fixture.childRun.id)]: 2 }),
      ).rejects.toThrowError(
        expect.objectContaining({
          message: `successful parent run is missing its release validation manifest: ${fixture.runId}`,
          refreshable: true,
        }),
      );
      client.loadManifest = loadManifest;

      releaseChecksEvidence.jobs[0]!.conclusion = "failure";
      let malformedError: unknown;
      try {
        await validate();
      } catch (error) {
        malformedError = error;
      }
      expect(malformedError).toMatchObject({
        message: expect.stringContaining("digest is invalid"),
      });
      expect(malformedError).not.toHaveProperty("refreshable");

      releaseChecksEvidence.jobs[0]!.conclusion = "success";
      fixture.childRun.actor = { login: "release-operator" };
      await expect(validate()).rejects.toThrow("execution plan child dispatch tuple mismatch");
    },
  );

  it("rejects a parent recovery that reruns a sealed child dispatch slot", () => {
    const child = expectedChildDispatches("28717729503", 2, "main").find(
      (entry) => entry.manifestKey === "releaseChecks",
    );
    if (!child) {
      throw new Error("missing release checks fixture");
    }
    const parentManifest = { runAttempt: 2, runId: "28717729503" };
    const parentJobs = [
      {
        completed_at: "2026-08-22T00:01:00Z",
        conclusion: "success",
        id: 900,
        name: child.parentJobName,
        run_attempt: 1,
        started_at: "2026-08-22T00:00:00Z",
        status: "completed",
        steps: [],
      },
      {
        completed_at: "2026-08-22T00:02:00Z",
        conclusion: "success",
        id: 901,
        name: child.parentJobName,
        run_attempt: 2,
        started_at: "2026-08-22T00:01:00Z",
        status: "completed",
        steps: [],
      },
    ];

    expect(() =>
      selectManifestParentJob(parentJobs, child, parentManifest, 1, {
        requireSkippedCarryForward: true,
      }),
    ).toThrow("manifest parent job was redispatched during recovery");
  });

  it.each([
    ["beta", "Run QA Lab parity lane (core)"],
    ...["beta", "stable", "full"].flatMap((profile) => [
      [profile, "Run QA Lab live Telegram lane"],
      [profile, "Run package acceptance / Telegram package acceptance / Run Telegram package E2E"],
      [profile, "cross_os_release_checks / Windows / packaged fresh"],
      [profile, "cross_os_release_checks / macOS / packaged upgrade"],
    ]),
  ])(
    "accepts %s advisory %s failures through canonical policy",
    async (releaseProfile, jobName) => {
      const fixture = trustedMainPackageFixture();
      fixture.manifest.releaseProfile = releaseProfile;
      fixture.childRun.conclusion = "failure";
      const originalClient = { ...fixture.client };
      fixture.client.getParentJobs = (requestedRunId: string) =>
        requestedRunId === String(fixture.childRun.id)
          ? [
              {
                completed_at: "2026-07-10T01:10:00Z",
                conclusion: "failure",
                id: 86293408711,
                name: jobName,
                run_attempt: 1,
                started_at: "2026-07-10T01:00:00Z",
                status: "completed",
                steps: [],
              },
              {
                completed_at: "2026-07-10T01:10:00Z",
                conclusion: "success",
                id: 86293408712,
                name: "Verify release checks",
                run_attempt: 1,
                started_at: "2026-07-10T01:00:00Z",
                status: "completed",
                steps: [],
              },
            ]
          : originalClient.getParentJobs(requestedRunId);

      const evidence = await validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      );
      expect(evidence.conclusions).toMatchObject({
        allRequiredSucceeded: true,
        children: { releaseChecks: "failure" },
      });
      expect(evidence.children[0]?.advisoryJobs).toEqual([
        {
          child: "releaseChecks",
          job: jobName,
          status: "completed",
          conclusion: "failure",
          policy: "advisory",
        },
      ]);
    },
  );

  it("accepts a trusted-main producer when the candidate is the same main commit", async () => {
    const sharedSha = "a".repeat(40);
    const fixture = trustedMainPackageFixture({
      targetSha: sharedSha,
      workflowSha: sharedSha,
    });
    expect(
      (
        await validateReleaseRunEvidence(
          {
            repository: "openclaw/openclaw",
            runId: fixture.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          fixture.client,
        )
      ).root,
    ).toMatchObject({
      targetSha: sharedSha,
      workflowRef: "main",
      workflowSha: sharedSha,
    });
  });

  it("binds v3 producer evidence to the exact trusted branch ref", async () => {
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowSha: "a".repeat(40),
    });
    const evidence = await validateReleaseRunEvidence(
      {
        repository: "openclaw/openclaw",
        runId: fixture.runId,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha: "c".repeat(40),
      },
      fixture.client,
    );
    expect(evidence.root).toMatchObject({
      producerOnTrustedMainLineage: true,
      workflowFullRef: "refs/heads/main",
      workflowRefProof: "manifest-v3-branch",
      workflowRefType: "branch",
      workflowRunPath: ".github/workflows/full-release-validation.yml",
    });
  });

  it("accepts a Unicode trusted workflow ref", async () => {
    const workflowRef = "release/unicode-\u{1f4a5}";
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha: "a".repeat(40),
    });
    const evidence = await validateReleaseRunEvidence(
      {
        repository: "openclaw/openclaw",
        runId: fixture.runId,
        trustedWorkflowRef: workflowRef,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha: "c".repeat(40),
      },
      fixture.client,
    );

    expect(evidence.root).toMatchObject({
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
    });
  });

  it("rejects a v3 producer dispatched from a tag named main", async () => {
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: "refs/tags/main",
      workflowRefType: "tag",
      workflowSha: "a".repeat(40),
    });
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow("producer workflow full ref is not trusted");
  });

  it("rejects a legacy producer outside the trusted main verifier lineage", async () => {
    const fixture = trustedMainPackageFixture({ workflowSha: "a".repeat(40) });
    fixture.client.compareCommitLineage = () => ({
      merge_base_commit: { sha: "d".repeat(40) },
      status: "diverged",
    });
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow("producer is not on the trusted main verifier lineage");
  });

  it("rejects a candidate branch producer even when its SHA differs from the target", async () => {
    const fixture = trustedMainPackageFixture({
      targetSha: "8".repeat(40),
      workflowRef: "release/2026.7.1",
      workflowSha: "7".repeat(40),
    });
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          trustedWorkflowRef: "main",
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow("producer must run from trusted workflow ref: main");
  });

  it("accepts canonical SHA-pinned v3 evidence on the trusted main lineage", async () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      targetSha: "8".repeat(40),
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;

    expect(
      (
        await validateReleaseRunEvidence(
          {
            repository: "openclaw/openclaw",
            runId: fixture.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          fixture.client,
        )
      ).root,
    ).toMatchObject({
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowRefProof: "manifest-v3-sha-pinned-main-ancestry",
      workflowSha,
    });
  });

  it("accepts canonical SHA-pinned v3 evidence exactly bound to a protected tooling tag", async () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const trustedWorkflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      targetSha: "8".repeat(40),
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;

    expect(
      await validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          trustedWorkflowFullRef: `refs/tags/${trustedWorkflowRef}`,
          trustedWorkflowRef,
          trustedWorkflowSha: workflowSha,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).toMatchObject({
      producerOnTrustedMainLineage: false,
      trustedWorkflowFullRef: `refs/tags/${trustedWorkflowRef}`,
      trustedWorkflowRef,
      root: {
        workflowRef,
        workflowRefProof: "manifest-v3-protected-tag-exact-sha",
        workflowSha,
      },
    });
  });

  it("accepts protected-tag evidence from an older trusted tooling ancestor", async () => {
    const trustedWorkflowSha = "7".repeat(40);
    const trustedWorkflowRef = `release-publish/${trustedWorkflowSha.slice(0, 12)}-123`;
    const olderWorkflowSha = "6".repeat(40);
    const olderWorkflowRef = `release-ci/${olderWorkflowSha.slice(0, 12)}-1783705000000`;
    const olderFixture = trustedMainPackageFixture({
      manifestVersion: 3,
      targetSha: "8".repeat(40),
      workflowFullRef: `refs/heads/${olderWorkflowRef}`,
      workflowRef: olderWorkflowRef,
      workflowSha: olderWorkflowSha,
    });
    olderFixture.manifest.targetRef = olderFixture.targetSha;
    olderFixture.client.getRef = (fullRef: string) => ({
      object: { sha: trustedWorkflowSha },
      ref: fullRef,
    });
    olderFixture.client.compareCommitLineage = (base: string, head: string) => {
      expect(base).toBe(olderWorkflowSha);
      expect(head).toBe(trustedWorkflowSha);
      return {
        merge_base_commit: { sha: olderWorkflowSha },
        status: "ahead",
      };
    };

    expect(
      await validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: olderFixture.runId,
          trustedWorkflowFullRef: `refs/tags/${trustedWorkflowRef}`,
          trustedWorkflowRef,
          trustedWorkflowSha,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        olderFixture.client,
      ),
    ).toMatchObject({
      root: {
        workflowRef: olderWorkflowRef,
        workflowRefProof: "manifest-v3-protected-tag-tooling-lineage",
        workflowSha: olderWorkflowSha,
      },
    });
  });

  it("rejects protected-tag evidence from a same-name branch or unrelated producer", async () => {
    const trustedWorkflowSha = "7".repeat(40);
    const trustedWorkflowRef = `release-publish/${trustedWorkflowSha.slice(0, 12)}-123`;
    const validFixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowSha: trustedWorkflowSha,
    });

    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: validFixture.runId,
          trustedWorkflowFullRef: `refs/heads/${trustedWorkflowRef}`,
          trustedWorkflowRef,
          trustedWorkflowSha,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        validFixture.client,
      ),
    ).rejects.toThrow("must be a protected tag");

    const unrelatedWorkflowSha = "6".repeat(40);
    const unrelatedWorkflowRef = `release-ci/${unrelatedWorkflowSha.slice(0, 12)}-1783705000000`;
    const unrelatedFixture = trustedMainPackageFixture({
      manifestVersion: 3,
      targetSha: "8".repeat(40),
      workflowFullRef: `refs/heads/${unrelatedWorkflowRef}`,
      workflowRef: unrelatedWorkflowRef,
      workflowSha: unrelatedWorkflowSha,
    });
    unrelatedFixture.manifest.targetRef = unrelatedFixture.targetSha;
    unrelatedFixture.client.getRef = (fullRef: string) => ({
      object: { sha: trustedWorkflowSha },
      ref: fullRef,
    });
    unrelatedFixture.client.compareCommitLineage = () => ({
      merge_base_commit: { sha: "5".repeat(40) },
      status: "diverged",
    });
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: unrelatedFixture.runId,
          trustedWorkflowFullRef: `refs/tags/${trustedWorkflowRef}`,
          trustedWorkflowRef,
          trustedWorkflowSha,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        unrelatedFixture.client,
      ),
    ).rejects.toThrow("not on the trusted tooling lineage");

    const sameNameFixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${trustedWorkflowRef}`,
      workflowRef: trustedWorkflowRef,
      workflowSha: trustedWorkflowSha,
    });
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: sameNameFixture.runId,
          trustedWorkflowFullRef: `refs/tags/${trustedWorkflowRef}`,
          trustedWorkflowRef,
          trustedWorkflowSha,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        sameNameFixture.client,
      ),
    ).rejects.toThrow("canonical release-ci branch");
  });

  it("rejects a protected tooling tag that moved or disappeared after sealing", async () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const trustedWorkflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      targetSha: "8".repeat(40),
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;
    const options = {
      repository: "openclaw/openclaw",
      runId: fixture.runId,
      trustedWorkflowFullRef: `refs/tags/${trustedWorkflowRef}`,
      trustedWorkflowRef,
      trustedWorkflowSha: workflowSha,
      verifierSourceContent: readFileSync(SCRIPT),
      verifierSourceSha: "c".repeat(40),
    };

    fixture.client.getRef = (fullRef: string) => ({
      object: { sha: "6".repeat(40) },
      ref: fullRef,
    });
    await expect(validateReleaseRunEvidence(options, fixture.client)).rejects.toThrow(
      "protected tooling tag moved",
    );

    fixture.client.getRef = () => {
      throw new Error("HTTP 404");
    };
    await expect(validateReleaseRunEvidence(options, fixture.client)).rejects.toThrow(
      "protected tooling tag is unavailable",
    );
  });

  it.each(["main", "refs/heads/main"])(
    "accepts a REST workflow path qualified with %s",
    async (qualifiedRef) => {
      const fixture = trustedMainPackageFixture({
        manifestVersion: 3,
        parentPath: `.github/workflows/full-release-validation.yml@${qualifiedRef}`,
        workflowSha: "7".repeat(40),
      });

      expect(
        (
          await validateReleaseRunEvidence(
            {
              repository: "openclaw/openclaw",
              runId: fixture.runId,
              verifierSourceContent: readFileSync(SCRIPT),
              verifierSourceSha: "c".repeat(40),
            },
            fixture.client,
          )
        ).root,
      ).toMatchObject({ workflowFullRef: "refs/heads/main" });
    },
  );

  it("accepts SHA-pinned producer identity with exact-target evidence reuse", () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;
    fixture.manifest.evidenceReuse = {
      changedPaths: [],
      evidenceSha: fixture.targetSha,
      policy: "exact-target-full-validation-v1",
      runId: "29071366024",
      selectedRunId: "29071366024",
    };

    expect(
      validateTrustedProducerIdentity(
        {
          manifest: fixture.manifest,
          parentRun: fixture.parentRun,
        },
        fixture.client,
        { sourceSha: "c".repeat(40) },
        "main",
      ),
    ).toMatchObject({
      producerOnTrustedMainLineage: true,
      workflowRefProof: "manifest-v3-sha-pinned-main-ancestry",
    });
  });

  it("rejects a SHA-pinned evidenceReuse field even when false", async () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;
    fixture.manifest.evidenceReuse = false;

    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow("evidence reuse is invalid");
  });

  it("rejects dirty verifier bytes and a forged verifier source SHA", async () => {
    const fixture = trustedMainPackageFixture();
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: "different verifier bytes",
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow("verifier script differs from its source SHA");
    await expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceSha: "f".repeat(40),
        },
        fixture.client,
      ),
    ).rejects.toThrow("verifier source blob is unavailable");
  });

  it("binds verifier bytes from the repository root even outside the caller cwd", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "release-verifier-repo-"));
    const outsideCwd = mkdtempSync(join(tmpdir(), "release-verifier-cwd-"));
    try {
      const scriptPath = join(repositoryRoot, SCRIPT);
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(scriptPath, readFileSync(SCRIPT));
      execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
      execFileSync("git", ["add", SCRIPT], { cwd: repositoryRoot });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Release Test",
          "-c",
          "user.email=release-test@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-qm",
          "test verifier",
        ],
        { cwd: repositoryRoot },
      );
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();

      const moduleUrl = pathToFileURL(resolve(SCRIPT)).href;
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { resolveVerifierIdentity } from ${JSON.stringify(moduleUrl)};
           process.stdout.write(JSON.stringify(resolveVerifierIdentity(
             process.env.SOURCE_SHA,
             undefined,
             process.env.REPOSITORY_ROOT,
           )));`,
        ],
        {
          cwd: outsideCwd,
          encoding: "utf8",
          env: {
            ...process.env,
            REPOSITORY_ROOT: repositoryRoot,
            SOURCE_SHA: sourceSha,
          },
        },
      );
      expect(JSON.parse(output)).toMatchObject({
        script: SCRIPT,
        sourceSha,
      });
    } finally {
      rmSync(repositoryRoot, { force: true, recursive: true });
      rmSync(outsideCwd, { force: true, recursive: true });
    }
  });

  it("binds the parent to the exact Full Release Validation REST run", () => {
    const parentView = {
      attempt: 2,
      headBranch: "main",
      headSha: "a".repeat(40),
    };
    const parentRest = {
      event: "workflow_dispatch",
      head_branch: parentView.headBranch,
      head_sha: parentView.headSha,
      id: 29090000000,
      path: ".github/workflows/full-release-validation.yml@refs/heads/main",
      run_attempt: parentView.attempt,
    };

    expect(validateParentRunBinding(parentView, parentRest, "29090000000")).toBe(parentRest);
    expect(() =>
      validateParentRunBinding(
        parentView,
        { ...parentRest, path: ".github/workflows/openclaw-release-checks.yml" },
        "29090000000",
      ),
    ).toThrow("full release parent run binding mismatch");
  });

  it("derives every child title from the exact parent run and attempt", () => {
    expect(expectedChildDispatches("29090000000", 3, "release/2026.7.1")).toEqual([
      {
        displayTitle: "CI full-release-validation-29090000000-3-ci",
        headBranch: "release/2026.7.1",
        manifestKey: "normalCi",
        name: "CI",
        parentJobName: "Run normal full CI",
        suffix: "-ci",
        trustedRef: "parent",
        workflow: "ci.yml",
      },
      {
        displayTitle:
          "OpenClaw Release Checks full-release-validation-29090000000-3-release-checks",
        headBranch: "release/2026.7.1",
        manifestKey: "releaseChecks",
        name: "OpenClaw Release Checks",
        parentJobName: "Run release/live/Docker/QA validation",
        suffix: "-release-checks",
        trustedRef: "parent",
        workflow: "openclaw-release-checks.yml",
      },
      {
        displayTitle: "Plugin Prerelease full-release-validation-29090000000-3-plugin-prerelease",
        headBranch: "release/2026.7.1",
        manifestKey: "pluginPrerelease",
        name: "Plugin Prerelease",
        parentJobName: "Run plugin prerelease validation",
        suffix: "-plugin-prerelease",
        trustedRef: "parent",
        workflow: "plugin-prerelease.yml",
      },
      {
        displayTitle: "NPM Telegram Beta E2E full-release-validation-29090000000-3-npm-telegram",
        headBranch: "release/2026.7.1",
        manifestKey: "npmTelegram",
        name: "NPM Telegram Beta E2E",
        parentJobName: "Run package Telegram E2E",
        suffix: "-npm-telegram",
        trustedRef: "parent",
        workflow: "npm-telegram-beta-e2e.yml",
      },
      {
        displayTitle: "OpenClaw Performance full-release-validation-29090000000-3",
        headBranch: "release/2026.7.1",
        manifestKey: "productPerformance",
        name: "OpenClaw Performance",
        parentJobName: "Run product performance evidence",
        suffix: "",
        trustedRef: "parent",
        workflow: "openclaw-performance.yml",
      },
    ]);
  });

  it("derives distinct titles for every phased release child", () => {
    expect(
      expectedChildDispatches("29090000000", 3, "release/2026.7.1", 3)
        .filter(({ manifestKey }) =>
          [
            "releaseChecksIndependent",
            "releaseChecksCandidate",
            "pluginPrereleaseIndependent",
            "pluginPrereleaseCandidate",
          ].includes(manifestKey),
        )
        .map(({ displayTitle, manifestKey, parentJobName }) => ({
          displayTitle,
          manifestKey,
          parentJobName,
        })),
    ).toEqual([
      {
        displayTitle:
          "Plugin Prerelease full-release-validation-29090000000-3-plugin-prerelease-independent",
        manifestKey: "pluginPrereleaseIndependent",
        parentJobName: "Run plugin prerelease independent validation",
      },
      {
        displayTitle:
          "Plugin Prerelease full-release-validation-29090000000-3-plugin-prerelease-candidate",
        manifestKey: "pluginPrereleaseCandidate",
        parentJobName: "Run plugin prerelease candidate validation",
      },
      {
        displayTitle:
          "OpenClaw Release Checks full-release-validation-29090000000-3-release-checks-independent",
        manifestKey: "releaseChecksIndependent",
        parentJobName: "Run release checks independent validation",
      },
      {
        displayTitle:
          "OpenClaw Release Checks full-release-validation-29090000000-3-release-checks-candidate",
        manifestKey: "releaseChecksCandidate",
        parentJobName: "Run release checks candidate validation",
      },
    ]);
  });

  it("ignores same-SHA and nearby-name runs without the exact parent dispatch binding", () => {
    const expected = "OpenClaw Performance full-release-validation-29090000000-3";
    const exact = {
      display_title: expected,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "a".repeat(40),
      id: 303,
    };
    expect(
      selectExactChildRun(
        [
          {
            display_title: "OpenClaw Performance",
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: exact.head_sha,
            id: 101,
          },
          { ...exact, event: "push", id: 202 },
          exact,
        ],
        expected,
        "main",
      ),
    ).toBe(exact);
  });

  it("fails closed on duplicate exact dispatch bindings and ignores branch collisions", () => {
    const expected = "CI full-release-validation-29090000000-3-ci";
    const exact = {
      display_title: expected,
      event: "workflow_dispatch",
      head_branch: "main",
      id: 1,
    };
    expect(
      selectExactChildRun(
        [{ ...exact, head_branch: "release/2026.7.1", id: 0 }, exact],
        expected,
        "main",
      ),
    ).toBe(exact);
    expect(() => selectExactChildRun([exact, { ...exact, id: 2 }], expected, "main")).toThrow(
      "multiple child runs have exact dispatch title and branch",
    );

    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toContain("created_at >= since");
    expect(source).not.toContain("head_sha === parent.headSha");
    expect(source).not.toContain("created:");
    expect(source).toContain("workflow-sha:");
    expect(source).toContain("candidate-sha:");
    expect(source).not.toContain("console.log(`sha:");
    expect(source).toContain("actions/workflows/${child.workflow}/runs");
  });

  it("returns one exact child after a full bounded pagination scan", () => {
    const expected = "OpenClaw Performance full-release-validation-29090000000-3";
    const exact = {
      display_title: expected,
      event: "workflow_dispatch",
      head_branch: "main",
      id: 999,
    };
    const pages = Array.from({ length: 10 }, (_, pageIndex) =>
      Array.from({ length: 100 }, (_unused, runIndex) => ({
        display_title: `decoy-${pageIndex}-${runIndex}`,
        event: "workflow_dispatch",
        head_branch: "main",
        id: pageIndex * 100 + runIndex,
      })),
    );
    expectDefined(pages[9], "last child run page")[99] = exact;

    expect(selectExactChildRunFromPages(pages, expected, "main")).toBe(exact);
    expectDefined(pages[0], "first child run page")[0] = { ...exact, id: 1001 };
    expect(() => selectExactChildRunFromPages(pages, expected, "main")).toThrow(
      "multiple child runs have exact dispatch title and branch",
    );
  });

  it("validates candidate identity and selected child completeness from the parent manifest", () => {
    const manifest = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    expect(manifest.targetSha).toBe("a".repeat(40));
    expect(manifest.rerunGroup).toBe("all");
    const children = expectedChildDispatches(manifest.runId, manifest.runAttempt, "main");
    const selected = requiredChildKeysForRerunGroup(manifest.rerunGroup);
    expect(manifestChildEntries(manifest, children, selected).map((entry) => entry.runId)).toEqual([
      "101",
      "404",
      "202",
      "303",
    ]);

    const missing = {
      ...manifest,
      childRunIds: { ...manifest.childRunIds, normalCi: "" },
    };
    expect(() => manifestChildEntries(missing, children, selected)).toThrow(
      "selected child is missing from manifest: CI",
    );
  });

  it("validates mixed-case composite job ordering using the producer contract", () => {
    const composite = composeReleaseAttemptJobs(
      [
        {
          jobs: [
            { conclusion: "success", name: "qa smoke ci", status: "completed" },
            { conclusion: "success", name: "QA Smoke CI", status: "completed" },
          ],
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    const releaseChecksEvidence = {
      compositeJobsSha256: composite.sha256,
      dispatchActor: "github-actions[bot]",
      effectiveRunAttempt: composite.effectiveRunAttempt,
      jobs: composite.jobs,
      observedRunAttempts: [1],
      plannedRunAttempt: composite.plannedRunAttempt,
      repository: "openclaw/openclaw",
      runId: "404",
      triggeringActor: "github-actions[bot]",
    };
    const raw = Object.assign(rawManifest({}), {
      childEvidence: {
        releaseChecks: releaseChecksEvidence,
      },
    });

    expect(() =>
      validateParentManifest(raw, {
        runAttempt: 2,
        runId: "29090000000",
      }),
    ).not.toThrow();

    const reversedJobs = composite.jobs.toReversed();
    const reversedCompositeJobsSha256 = releaseCompositeJobsSha256({
      effectiveRunAttempt: composite.effectiveRunAttempt,
      jobs: reversedJobs,
      plannedRunAttempt: composite.plannedRunAttempt,
    });
    releaseChecksEvidence.compositeJobsSha256 = reversedCompositeJobsSha256;
    releaseChecksEvidence.jobs = reversedJobs;

    expect(() =>
      validateParentManifest(raw, {
        runAttempt: 2,
        runId: "29090000000",
      }),
    ).toThrow("release validation child job identity is duplicated: releaseChecks");
  });

  it("requires the npm Telegram child for all-validation with an effective package spec", () => {
    const raw = rawManifest({});
    raw.childRuns.npmTelegram = "505";
    raw.validationInputs.npmTelegramPackageSpec = "openclaw@beta";
    raw.validationInputs.skipPackageTelegramE2e = "true";
    const manifest = validateParentManifest(raw, {
      runAttempt: 2,
      runId: "29090000000",
    });
    const selected = requiredChildKeysForRerunGroup(manifest.rerunGroup, manifest.validationInputs);
    expect([...selected].toSorted((left, right) => left.localeCompare(right))).toEqual([
      "normalCi",
      "npmTelegram",
      "pluginPrerelease",
      "productPerformance",
      "releaseChecks",
    ]);
    const missing = {
      ...manifest,
      childRunIds: { ...manifest.childRunIds, npmTelegram: "" },
    };
    expect(() =>
      manifestChildEntries(
        missing,
        expectedChildDispatches(manifest.runId, manifest.runAttempt, "main"),
        selected,
      ),
    ).toThrow("selected child is missing from manifest: NPM Telegram Beta E2E");
  });

  it.each(["2026.8.1", "2026.9.1", "2026.9.5"])(
    "validates the Telegram waiver for %s before changing package child coverage",
    (version) => {
      const raw = rawManifest({});
      raw.releaseProfile = "stable";
      Object.assign(raw.validationInputs, {
        telegramWaiver: `${version}-owner-approved`,
        targetVersion: version,
        releasePackageSpec: `openclaw@${version}`,
      });
      const expected = { runAttempt: 2, runId: "29090000000" };
      const manifest = validateParentManifest(raw, expected);
      expect(
        requiredChildKeysForRerunGroup(manifest.rerunGroup, manifest.validationInputs),
      ).not.toContain("npmTelegram");
      raw.validationInputs.targetVersion = "2026.8.2";
      expect(() => validateParentManifest(raw, expected)).toThrow(/Telegram waiver/u);
    },
  );

  it("rejects an unreviewed self-declared Telegram waiver", () => {
    const raw = rawManifest({});
    raw.releaseProfile = "stable";
    Object.assign(raw.validationInputs, {
      telegramWaiver: "2026.10.1-owner-approved",
      targetVersion: "2026.10.1",
      releasePackageSpec: "openclaw@2026.10.1",
    });
    expect(() => validateParentManifest(raw, { runAttempt: 2, runId: "29090000000" })).toThrow(
      /Telegram waiver/u,
    );
  });

  it.each([
    { label: "legacy manifest", version: 3 },
    { label: "stable profile", releaseProfile: "stable" },
    { label: "full profile", releaseProfile: "full" },
    { label: "soak", runReleaseSoak: "true" },
    { label: "focused run", rerunGroup: "package" },
    { label: "stable target", targetVersion: "2026.8.28" },
    { label: "unknown policy", coveragePolicy: "unknown" },
  ])("rejects reduced coverage in a $label", (drift) => {
    const fixture = trustedMainFullFixture();
    Object.assign(fixture.manifest, {
      releaseProfile: "beta",
      runReleaseSoak: "false",
      ...Object.fromEntries(
        Object.entries(drift).filter(([key]) =>
          ["version", "releaseProfile", "runReleaseSoak", "rerunGroup"].includes(key),
        ),
      ),
    });
    Object.assign(fixture.manifest.validationInputs, {
      coveragePolicy: drift.coveragePolicy ?? "npm-beta-v1",
      targetVersion: drift.targetVersion ?? "2026.8.28-beta.1",
    });
    expect(() =>
      validateParentManifest(fixture.manifest, {
        runId: fixture.runId,
        runAttempt: 1,
        workflowSha: fixture.workflowSha,
      }),
    ).toThrow(/coverage/iu);
  });

  it("keeps historical non-reuse v2 manifests readable without validation inputs", () => {
    const legacy = rawManifest({});
    delete (legacy as { validationInputs?: unknown }).validationInputs;
    const manifest = validateParentManifest(legacy, {
      runAttempt: 2,
      runId: "29090000000",
    });

    expect(manifest.validationInputs).toBeUndefined();
    expect(manifest.rerunGroup).toBe("all");
  });

  it.each([
    [2, "release-checks"],
    [2, "qa"],
    [3, "release-checks"],
    [3, "qa"],
  ] as const)("keeps historical v%s %s manifests readable", (version, rerunGroup) => {
    const workflowSha = version === 3 ? "b".repeat(40) : undefined;
    const manifest = validateParentManifest(rawManifest({ rerunGroup, version, workflowSha }), {
      runAttempt: 2,
      runId: "29090000000",
      workflowSha,
    });

    expect(manifest.rerunGroup).toBe(rerunGroup);
    expect(manifest.version).toBe(version);
  });

  it("binds v3 manifests to their immutable producer workflow SHA", () => {
    const workflowSha = "b".repeat(40);
    const manifest = validateParentManifest(rawManifest({ version: 3, workflowSha }), {
      runAttempt: 2,
      runId: "29090000000",
      workflowRef: "main",
      workflowSha,
    });
    expect(manifest).toMatchObject({
      version: 3,
      workflowSha,
    });
    expect(() =>
      validateParentManifest(rawManifest({ version: 3, workflowSha }), {
        runAttempt: 2,
        runId: "29090000000",
        workflowSha: "c".repeat(40),
      }),
    ).toThrow("release validation manifest workflow SHA mismatch");
  });

  it("binds v3 manifests to the candidate sealed by the execution plan", () => {
    const workflowSha = "b".repeat(40);
    const candidateBinding = fullReleaseCandidateBindingFixture({
      releaseProfile: "beta",
      releaseSoak: false,
      targetSha: "a".repeat(40),
      toolingSha: workflowSha,
      upgradeSurvivorScenarios: "",
    });
    const manifest = validateParentManifest(
      rawManifest({ candidateBinding, version: 3, workflowSha }),
      {
        candidateBinding,
        repository: "openclaw/openclaw",
        runAttempt: 2,
        runId: "29090000000",
        workflowSha,
      },
    );
    expect(manifest.candidateBinding).toEqual(candidateBinding);
    expect(() =>
      validateParentManifest(rawManifest({ candidateBinding: null, version: 3, workflowSha }), {
        candidateBinding,
        repository: "openclaw/openclaw",
        runAttempt: 2,
        runId: "29090000000",
        workflowSha,
      }),
    ).toThrow("candidate differs from the immutable plan");
  });

  it("requires v3 manifests to record artifact-only performance publication", () => {
    const workflowSha = "b".repeat(40);
    const missing = rawManifest({ version: 3, workflowSha });
    delete (
      missing.controls as {
        performanceReportPublication?: string;
      }
    ).performanceReportPublication;
    expect(() =>
      validateParentManifest(missing, {
        runAttempt: 2,
        runId: "29090000000",
        workflowSha,
      }),
    ).toThrow("release validation manifest performance report publication mode is invalid");

    const publishing = rawManifest({ version: 3, workflowSha });
    publishing.controls.performanceReportPublication = "publish";
    expect(() =>
      validateParentManifest(publishing, {
        runAttempt: 2,
        runId: "29090000000",
        workflowSha,
      }),
    ).toThrow("release validation manifest performance report publication mode is invalid");
  });

  it("requires a successful artifact-only performance guard and skipped publishers", () => {
    const guard = {
      conclusion: "success",
      name: "Verify artifact-only report mode",
      status: "completed",
    };
    const skippedPublisher = {
      conclusion: "skipped",
      name: "Publish mock provider report",
      status: "completed",
    };
    expect(validatePerformanceArtifactOnlyJobs([guard, skippedPublisher])).toBe(guard);
    expect(() => validatePerformanceArtifactOnlyJobs([skippedPublisher])).toThrow(
      "performance artifact-only guard is missing or unsuccessful",
    );
    expect(() =>
      validatePerformanceArtifactOnlyJobs([{ ...guard, conclusion: "failure" }]),
    ).toThrow("performance artifact-only guard is missing or unsuccessful");
    expect(() =>
      validatePerformanceArtifactOnlyJobs([guard, { ...skippedPublisher, conclusion: "success" }]),
    ).toThrow("performance report publisher was not skipped");
  });

  it("requires the child mapped by rerunGroup and scans only selected in-progress workflows", () => {
    expect(() => requiredChildKeysForRerunGroup("release-checks")).toThrow(
      "release validation manifest rerun group is invalid: release-checks",
    );
    expect(() => requiredChildKeysForRerunGroup("qa")).toThrow(
      "release validation manifest rerun group is invalid: qa",
    );
    const focused = validateParentManifest(
      {
        ...rawManifest({ rerunGroup: "npm-telegram" }),
        childRuns: {
          normalCi: "",
          npmTelegram: "",
          pluginPrerelease: "",
          productPerformance: { runId: "" },
          releaseChecks: "",
        },
      },
      { runAttempt: 2, runId: "29090000000" },
    );
    const selected = requiredChildKeysForRerunGroup(focused.rerunGroup);
    const children = expectedSelectedChildDispatches(
      focused.runId,
      focused.runAttempt,
      focused.workflowRef,
      selected,
    );
    expect(children.map((child) => child.manifestKey)).toEqual(["npmTelegram"]);
    expect(() => manifestChildEntries(focused, children, selected)).toThrow(
      "selected child is missing from manifest: NPM Telegram Beta E2E",
    );

    const inProgress = selectedChildKeys([
      { conclusion: "skipped", name: "Run normal full CI" },
      { conclusion: "skipped", name: "Run plugin prerelease validation" },
      { conclusion: undefined, name: "Run product performance evidence" },
      { conclusion: "skipped", name: "Run release/live/Docker/QA validation" },
    ]);
    expect(
      expectedSelectedChildDispatches("29090000000", 2, "main", inProgress).map(
        (child) => child.manifestKey,
      ),
    ).toEqual(["productPerformance"]);
  });

  it("authorizes only exact-target reuse through the selected root manifest", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const current = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: root.targetSha,
      }),
      { runAttempt: 2, runId: "29090000001" },
    );

    expect(validateEvidenceReuseChain(current, root, root)).toBe(root.targetSha);
    expect(current.targetSha).toBe(root.targetSha);
  });

  it("accepts a verified changelog-only release delta", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const changedPaths = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: ["CHANGELOG.md"],
          evidenceSha: root.targetSha,
          policy: "changelog-only-release-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: "b".repeat(40),
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    expect(
      validateEvidenceReuseChain(changedPaths, root, root, (base: string, head: string) => ({
        files: [{ filename: "CHANGELOG.md", status: "modified" }],
        merge_base_commit: { sha: base },
        status: head === changedPaths.targetSha ? "ahead" : "diverged",
      })),
    ).toBe(root.targetSha);
  });

  it("rejects unverified changed paths and cross-SHA exact-target reuse", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const changedPaths = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: ["CHANGELOG.md"],
          evidenceSha: root.targetSha,
          policy: "changelog-only-release-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: "b".repeat(40),
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    expect(() =>
      validateEvidenceReuseChain(changedPaths, root, root, (base: string) => ({
        files: [{ filename: "src/index.ts" }],
        merge_base_commit: { sha: base },
        status: "ahead",
      })),
    ).toThrow("failed commit comparison");

    expect(() =>
      validateEvidenceReuseChain(changedPaths, root, root, (base: string) => ({
        files: [
          {
            filename: "CHANGELOG.md",
            previous_filename: "src/index.ts",
            status: "renamed",
          },
        ],
        merge_base_commit: { sha: base },
        status: "ahead",
      })),
    ).toThrow("failed commit comparison");

    const changedTarget = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: "b".repeat(40),
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    expect(() => validateEvidenceReuseChain(changedTarget, root, root)).toThrow(
      "exact-target release evidence reuse requires no changed paths",
    );
  });

  it.each(["2026.7.1", "2026.7.1-beta.1"])(
    "binds %s split changelog reuse to the selected release entry and matching record",
    (targetVersion) => {
      const inputs = { ...rawManifest({}).validationInputs, targetVersion };
      const root = validateParentManifest(
        { ...rawManifest({}), validationInputs: inputs },
        {
          runAttempt: 2,
          runId: "29090000000",
        },
      );
      const paths = ["CHANGELOG.md", "CHANGELOG/2026.7.1.md", "CHANGELOG/records/2026.7.1.md"];
      const makeCurrent = (changedPaths: string[]) =>
        validateParentManifest(
          {
            ...rawManifest({
              evidenceReuse: {
                changedPaths,
                evidenceSha: root.targetSha,
                policy: "split-changelog-release-v1",
                runId: root.runId,
                selectedRunId: root.runId,
              },
              runId: "29090000001",
              targetSha: "b".repeat(40),
            }),
            validationInputs: inputs,
          },
          { runAttempt: 2, runId: "29090000001" },
        );
      const compare = (changedPaths: string[]) => (base: string) => ({
        files: changedPaths.map((filename) => ({ filename, status: "modified" })),
        merge_base_commit: { sha: base },
        status: "ahead",
      });
      expect(validateEvidenceReuseChain(makeCurrent(paths), root, root, compare(paths))).toBe(
        root.targetSha,
      );
      for (const unrelated of [
        "CHANGELOG/2026.8.1.md",
        "CHANGELOG/records/2026.8.1.md",
        "src/index.ts",
      ]) {
        const changedPaths = [...paths, unrelated];
        expect(() =>
          validateEvidenceReuseChain(makeCurrent(changedPaths), root, root, compare(changedPaths)),
        ).toThrow("invalid target delta");
        expect(() =>
          validateEvidenceReuseChain(makeCurrent(paths), root, root, compare(changedPaths)),
        ).toThrow("failed commit comparison");
      }
      for (const filename of paths.slice(1)) {
        for (const status of ["removed", "renamed"]) {
          expect(() =>
            validateEvidenceReuseChain(makeCurrent(paths), root, root, (base: string) => ({
              ...compare(paths)(base),
              files: paths.map((path) => ({
                filename: path,
                status: path === filename ? status : "modified",
                previous_filename:
                  path === filename && status === "renamed" ? "src/index.ts" : undefined,
              })),
            })),
          ).toThrow("failed commit comparison");
        }
      }
      if (targetVersion.endsWith("-beta.1")) {
        const betaPaths = [
          "CHANGELOG.md",
          `CHANGELOG/${targetVersion}.md`,
          `CHANGELOG/records/${targetVersion}.md`,
        ];
        expect(() =>
          validateEvidenceReuseChain(makeCurrent(betaPaths), root, root, compare(betaPaths)),
        ).toThrow("invalid target delta");
      }
      expect(() =>
        validateEvidenceReuseChain(
          makeCurrent(["CHANGELOG.md"]),
          root,
          root,
          compare(["CHANGELOG.md"]),
        ),
      ).toThrow("invalid target delta");
    },
  );

  it("rejects exact-target reuse without matching root policy and authorization", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const current = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: root.targetSha,
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    const mismatchedRoot = {
      ...root,
      validationInputs: {
        ...root.validationInputs,
        npmTelegramScenario: "telegram-status-command",
      },
    };

    expect(() => validateEvidenceReuseChain(current, mismatchedRoot, mismatchedRoot)).toThrow(
      "evidence reuse current manifest policy differs from the chain root",
    );
    expect(() =>
      validateEvidenceReuseChain({ ...current, evidenceReuse: undefined }, root, root),
    ).toThrow("does not authorize evidence reuse");
  });

  it("rejects any selected manifest that itself reuses evidence", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const intermediate = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: root.targetSha,
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    const current = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: intermediate.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: intermediate.runId,
        },
        runId: "29090000002",
        targetSha: intermediate.targetSha,
      }),
      { runAttempt: 2, runId: "29090000002" },
    );

    expect(() => validateEvidenceReuseChain(current, intermediate, root)).toThrow(
      "evidence reuse must select a root execution manifest",
    );
  });

  it("binds each manifest workflow ref to the fetched parent branch", () => {
    expect(() =>
      validateParentManifest(rawManifest({}), {
        runAttempt: 2,
        runId: "29090000000",
        workflowRef: "release/2026.7.1",
      }),
    ).toThrow("release validation manifest workflow ref mismatch");
  });

  it("validates manifest child workflow, dispatch tuple, branch, and attempt", () => {
    const child = expectDefined(
      expectedChildDispatches("29090000000", 3, "main")[0],
      "expected CI child dispatch",
    );
    const parentManifest = {
      runAttempt: 3,
      runId: "29090000000",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
    };
    const parentJobs = [
      {
        completed_at: "2026-07-10T01:10:00Z",
        conclusion: "success",
        id: 901,
        name: child.parentJobName,
        run_attempt: 3,
        started_at: "2026-07-10T01:00:00Z",
        status: "completed",
        steps: [],
      },
    ];
    const parentLog = [
      `TARGET_SHA: ${parentManifest.targetSha}`,
      "Dispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/101 (attempt 1)",
    ].join("\n");
    const run = {
      actor: { login: "github-actions[bot]" },
      display_title: child.displayTitle,
      event: "workflow_dispatch",
      head_branch: child.headBranch,
      head_sha: parentManifest.workflowSha,
      id: 101,
      path: ".github/workflows/ci.yml@refs/heads/main",
      run_attempt: 1,
      triggering_actor: { login: "github-actions[bot]" },
    };
    expect(validateManifestChildRun(run, child, "101", parentManifest, parentJobs, parentLog)).toBe(
      run,
    );
    expect(() =>
      validateManifestChildRun(
        { ...run, head_branch: "release/2026.7.1" },
        child,
        "101",
        parentManifest,
        parentJobs,
        parentLog,
      ),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(() =>
      validateParentManifest(rawManifest({}), { runAttempt: 3, runId: "29090000000" }),
    ).toThrow("release validation manifest run attempt mismatch");
  });

  it("accepts strongly bound legacy and correlated children across parent attempts", () => {
    const parentManifest = {
      runAttempt: 2,
      runId: "28717729503",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
    };
    const children = expectedChildDispatches(
      parentManifest.runId,
      parentManifest.runAttempt,
      "main",
    );
    const fixtures = new Map([
      ["normalCi", { originAttempt: 2, runId: 28718903263, title: "CI" }],
      ["pluginPrerelease", { originAttempt: 1, runId: 28717802268, title: "Plugin Prerelease" }],
      [
        "productPerformance",
        {
          originAttempt: 1,
          runId: 28717802171,
          title: "OpenClaw Performance full-release-validation-28717729503-1",
        },
      ],
      ["releaseChecks", { originAttempt: 1, runId: 28717802397, title: "OpenClaw Release Checks" }],
    ]);
    const fingerprint = {
      completed_at: "2026-07-04T20:29:21Z",
      conclusion: "success",
      started_at: "2026-07-04T19:53:02Z",
      status: "completed",
      steps: [
        {
          completed_at: "2026-07-04T20:29:20Z",
          conclusion: "success",
          name: "Dispatch and monitor child",
          number: 1,
          started_at: "2026-07-04T19:53:03Z",
          status: "completed",
        },
      ],
    };

    for (const child of children.filter((entry) => fixtures.has(entry.manifestKey))) {
      const fixture = fixtures.get(child.manifestKey);
      if (!fixture) {
        throw new Error(`missing fixture for ${child.manifestKey}`);
      }
      const { originAttempt, runId, title } = fixture;
      const parentJobs = [
        ...(originAttempt === 1
          ? [
              {
                ...fingerprint,
                id: 900,
                name: child.parentJobName,
                run_attempt: 1,
              },
            ]
          : []),
        {
          ...fingerprint,
          id: 901,
          name: child.parentJobName,
          run_attempt: 2,
        },
      ];
      const run = {
        actor: { login: "github-actions[bot]" },
        display_title: title,
        event: "workflow_dispatch",
        head_branch: child.headBranch,
        head_sha: parentManifest.workflowSha,
        id: runId,
        path: `.github/workflows/${child.workflow}@refs/heads/${child.headBranch}`,
        run_attempt: 1,
        triggering_actor: { login: "github-actions[bot]" },
      };
      const parentLog = [
        `TARGET_SHA: ${parentManifest.targetSha}`,
        ...(child.manifestKey === "productPerformance" ? ["-f publish_reports=false"] : []),
        `Dispatched ${child.workflow}: https://github.com/openclaw/openclaw/actions/runs/${runId} (attempt ${run.run_attempt})`,
      ].join("\n");
      expect(resolveManifestChildOriginAttempt(run, child, parentManifest, parentJobs)).toBe(
        originAttempt,
      );
      expect(
        validateManifestChildRun(run, child, String(runId), parentManifest, parentJobs, parentLog),
      ).toBe(run);
      expect(
        validateManifestChildRun(
          run,
          child,
          String(runId),
          parentManifest,
          parentJobs,
          parentLog.replace(` (attempt ${run.run_attempt})`, ""),
        ),
      ).toBe(run);
      if (child.manifestKey === "productPerformance") {
        expect(() =>
          validateManifestChildRun(
            run,
            child,
            String(runId),
            parentManifest,
            parentJobs,
            parentLog.replace("-f publish_reports=false\n", ""),
          ),
        ).toThrow("release performance child is not dispatched in artifact-only mode");
      }
    }

    const ci = children.find((child) => child.manifestKey === "normalCi");
    if (!ci) {
      throw new Error("missing CI child fixture");
    }
    const wrongParent = {
      display_title: `CI full-release-validation-28717729504-1-ci`,
      event: "workflow_dispatch",
      head_branch: "main",
      id: 101,
      path: ".github/workflows/ci.yml@refs/heads/main",
    };
    const ciJobs = [
      {
        ...fingerprint,
        id: 901,
        name: ci.parentJobName,
        run_attempt: 2,
      },
    ];
    const ciLog = [
      `TARGET_SHA: ${parentManifest.targetSha}`,
      "Dispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/101 (attempt 1)",
    ].join("\n");
    expect(() =>
      validateManifestChildRun(wrongParent, ci, "101", parentManifest, ciJobs, ciLog),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(() =>
      validateManifestChildRun(
        {
          ...wrongParent,
          display_title: `CI full-release-validation-${parentManifest.runId}-3-ci`,
        },
        ci,
        "101",
        parentManifest,
        ciJobs,
        ciLog,
      ),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(
      resolveManifestChildOriginAttempt({ display_title: "CI nearby" }, ci, parentManifest, ciJobs),
    ).toBeUndefined();
  });

  it("keeps requested changelog reuse target and evidence SHAs separate", () => {
    const evidenceSha = "a".repeat(40);
    const targetSha = "b".repeat(40);
    expect(() =>
      validateRequestedEvidenceReuse(
        {
          evidenceReuse: {
            changedPaths: ["CHANGELOG.md"],
            evidenceSha,
            policy: "changelog-only-release-v1",
            runId: "101",
            selectedRunId: "101",
          },
          runId: "101",
          targetSha,
        },
        { runId: "101", targetSha: evidenceSha },
        { runId: "101", targetSha: evidenceSha },
        {
          expectedChangedPaths: ["CHANGELOG.md"],
          expectedEvidencePolicy: "changelog-only-release-v1",
          expectedEvidenceSha: evidenceSha,
          expectedRootRunId: "101",
          expectedSelectedRunId: "101",
          expectedTargetSha: targetSha,
        },
      ),
    ).not.toThrow();
    expect(() =>
      validateRequestedEvidenceReuse(
        {
          evidenceReuse: {
            changedPaths: ["CHANGELOG.md"],
            evidenceSha,
            policy: "changelog-only-release-v1",
            runId: "101",
            selectedRunId: "101",
          },
          runId: "101",
          targetSha,
        },
        { runId: "101", targetSha },
        { runId: "101", targetSha },
        {
          expectedChangedPaths: ["CHANGELOG.md"],
          expectedEvidencePolicy: "changelog-only-release-v1",
          expectedEvidenceSha: evidenceSha,
          expectedRootRunId: "101",
          expectedSelectedRunId: "101",
          expectedTargetSha: targetSha,
        },
      ),
    ).toThrow("no longer matches");
  });

  it.each([
    {
      changedPaths: [],
      policy: "exact-target-full-validation-v1",
      targetSha: "a".repeat(40),
    },
    {
      changedPaths: ["CHANGELOG.md"],
      policy: "changelog-only-release-v1",
      targetSha: "b".repeat(40),
    },
  ])("validates the complete prospective $policy selection tuple", (selection) => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    expect(() =>
      validateRequestedEvidenceReuse(
        root,
        root,
        root,
        {
          expectedChangedPaths: selection.changedPaths,
          expectedEvidencePolicy: selection.policy,
          expectedEvidenceSha: root.targetSha,
          expectedRootRunId: root.runId,
          expectedSelectedRunId: root.runId,
          expectedTargetSha: selection.targetSha,
        },
        (base: string) => ({
          files: [{ filename: "CHANGELOG.md", status: "modified" }],
          merge_base_commit: { sha: base },
          status: "ahead",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateRequestedEvidenceReuse(
        root,
        root,
        root,
        {
          expectedChangedPaths: selection.changedPaths,
          expectedEvidencePolicy: selection.policy,
          expectedEvidenceSha: root.targetSha,
          expectedRootRunId: root.runId,
          expectedSelectedRunId: "29090000001",
          expectedTargetSha: selection.targetSha,
        },
        () => ({ status: "identical" }),
      ),
    ).toThrow("no longer matches");
  });

  it("rejects carried parent jobs whose selected-attempt execution fingerprint changed", () => {
    const child = expectedChildDispatches("28717729503", 2, "main").find(
      (entry) => entry.manifestKey === "pluginPrerelease",
    );
    if (!child) {
      throw new Error("missing plugin prerelease fixture");
    }
    const parentManifest = { runAttempt: 2, runId: "28717729503" };
    const parentJobs = [
      {
        completed_at: "2026-07-04T20:29:21Z",
        conclusion: "success",
        id: 900,
        name: child.parentJobName,
        run_attempt: 1,
        started_at: "2026-07-04T19:53:02Z",
        status: "completed",
        steps: [],
      },
      {
        completed_at: "2026-07-04T20:30:21Z",
        conclusion: "success",
        id: 901,
        name: child.parentJobName,
        run_attempt: 2,
        started_at: "2026-07-04T19:53:02Z",
        status: "completed",
        steps: [],
      },
    ];

    expect(() => selectManifestParentJob(parentJobs, child, parentManifest, 1)).toThrow(
      "manifest parent job carry-forward fingerprint mismatch",
    );
  });
});

describe("lane waiver advisory evidence", () => {
  const job = (name: string, conclusion = "failure") => ({ name, status: "completed", conclusion });
  const childEvidence = {
    normalCi: {
      jobs: [job("checks-node-fast"), job("checks-windows-node-test-1"), job("openclaw/ci-gate")],
    },
    releaseChecksCandidate: {
      jobs: [
        job("install_smoke_release_checks / installer_smoke"),
        job("cross_os_release_checks / Linux / packaged fresh"),
        job("Verify release checks"),
      ],
    },
  };

  it("records waived lanes with their reason and keeps proof lanes out", () => {
    const withWaiver = releaseAdvisoryJobEvidence(childEvidence, "stable", "main", "ship");
    expect(
      withWaiver.map((entry) => `${entry.child}:${entry.job}:${entry.reason ?? "policy"}`),
    ).toEqual([
      "normalCi:checks-node-fast:lane_waiver",
      "normalCi:checks-windows-node-test-1:policy",
      "normalCi:openclaw/ci-gate:lane_waiver",
      "releaseChecksCandidate:cross_os_release_checks / Linux / packaged fresh:lane_waiver",
    ]);
    expect(
      releaseAdvisoryJobEvidence(childEvidence, "stable", "main").map((entry) => entry.job),
    ).toEqual(["checks-windows-node-test-1"]);
  });
});
