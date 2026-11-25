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
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPublicationAdmission,
  createPublicationObservations,
  createPublicationSourceFact,
  publicationDispatchEnvelope,
  publicationObservationJson,
  publicationSourceRequest,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  composeReleaseAttemptJobs,
  MAX_RELEASE_ARTIFACT_BYTES,
  releaseCompositeJobsSha256,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  artifactDownloadTimeoutMs,
  createReleaseEvidenceClient,
  expectedChildDispatches,
  expectedSelectedChildDispatches,
  manifestChildEntries,
  readManifestArtifactArchive,
  requiredChildKeysForRerunGroup,
  restoreOriginalPublicationAdmission,
  resolveManifestChildOriginAttempt,
  runReleaseCiGh,
  selectExactChildRun,
  selectExactChildRunFromPages,
  selectManifestArtifact,
  selectManifestParentJob,
  selectedChildKeys,
  tryReadReleaseDecisionArtifact,
  validateEvidenceReuseChain,
  validateManifestArtifactIdentity,
  validateManifestChildRun,
  validateParentManifest,
  validateParentRunBinding,
  validatePerformanceArtifactOnlyJobs,
  validateReleaseRunEvidence,
  validateRequestedEvidenceReuse,
} from "../../scripts/release-ci-summary.mjs";
import { fullReleaseCandidateBindingFixture } from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import {
  rawManifest,
  trustedMainPackageFixture,
  trustedMainNpmFixture,
} from "./release-ci-summary.test-support.js";

const SCRIPT = "scripts/release-ci-summary.mjs";
const MANIFEST_ARTIFACT_ENTRY = "full-release-validation-manifest.json";
const hasUnzip = spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function ghFixture(root: string, replies: Record<string, unknown>, name = "gh") {
  const command = join(root, name);
  const calls = join(root, `${name}.calls`);
  const wire = Object.fromEntries(
    Object.entries(replies).map(([key, value]) => [
      key,
      Buffer.isBuffer(value) ? { $base64: value.toString("base64") } : value,
    ]),
  );
  writeFileSync(
    command,
    `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const replies = ${JSON.stringify(wire)};
const key = args[0] === "api" ? args[1] : args.slice(0, 2).join(" ");
const value = replies[key + " " + args[2]] ?? replies[key] ?? (key.includes("?") ? replies[key.split("?")[0] + "?*"] : undefined);
if (value === undefined) throw new Error("Unplanned gh request: " + args.join(" "));
process.stdout.write(value.$base64 ? Buffer.from(value.$base64, "base64") : typeof value === "string" ? value : JSON.stringify(value));
`,
    { mode: 0o755 },
  );
  return { command, calls };
}

function completedStep(
  name: string,
  number: number,
  start: number,
  end: number,
  conclusion = "success",
) {
  const time = (second: number) => `2026-08-28T12:01:0${second}.000Z`;
  return {
    name,
    number,
    status: "completed",
    conclusion,
    started_at: time(start),
    completed_at: time(end),
  };
}

function publicationPlanSteps(seal = "success", upload = "success", uploadNumber = 6) {
  return [
    completedStep("Seal immutable release execution plan", 5, 0, 1, seal),
    completedStep("Upload immutable release execution plan", uploadNumber, 1, 3, upload),
  ];
}

function publicationParent(fixture: ReturnType<typeof publicationRestoreFixture>) {
  return {
    ...fixture.parentRun,
    name: "Full Release Validation",
    display_title: "Full Release Validation",
    repository: { full_name: "openclaw/openclaw" },
    head_repository: { full_name: "openclaw/openclaw" },
  };
}

function planDigestStep(
  conclusion = "success",
  name = "Record immutable release execution plan digest",
) {
  return completedStep(name, 7, 3, 3, conclusion);
}

function verifierOptions(runId: string) {
  return { runId, verifierSourceContent: readFileSync(SCRIPT), verifierSourceSha: "c".repeat(40) };
}

function candidateVerifierOptions(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    ...verifierOptions(f.runId),
    repository: f.repository,
    trustedWorkflowRef: f.publisherFullRef.slice("refs/tags/".length),
    trustedWorkflowFullRef: f.publisherFullRef,
    trustedWorkflowSha: f.p,
    verifierSourceSha: f.p,
  };
}

function makeJob(
  name: string,
  overrides: Partial<ReturnType<typeof trustedMainPackageFixture>["parentJob"]> = {},
) {
  return {
    completed_at: "2026-07-10T01:10:00Z",
    conclusion: "success",
    id: 86293408710,
    name,
    run_attempt: 1,
    started_at: "2026-07-10T01:00:00Z",
    status: "completed",
    steps: [],
    ...overrides,
  };
}

function attemptEvidence(
  runId: string,
  attempts: Array<{ runAttempt: number; jobs: Array<Record<string, unknown>> }>,
  effectiveRunAttempt = attempts.length,
) {
  const composite = composeReleaseAttemptJobs(attempts, {
    plannedRunAttempt: 1,
    effectiveRunAttempt,
  });
  return {
    compositeJobsSha256: composite.sha256,
    dispatchActor: "github-actions[bot]",
    effectiveRunAttempt,
    jobs: composite.jobs,
    observedRunAttempts: attempts.map(({ runAttempt }) => runAttempt),
    plannedRunAttempt: 1,
    repository: "openclaw/openclaw",
    runId,
    triggeringActor: effectiveRunAttempt === 1 ? "github-actions[bot]" : "release-operator",
  };
}

function manifestFixture(
  overrides: Parameters<typeof rawManifest>[0] = {},
  expected: Partial<Parameters<typeof validateParentManifest>[1]> = {},
) {
  const raw = rawManifest(overrides);
  return validateParentManifest(raw, { runAttempt: 2, runId: raw.runId, ...expected });
}

function reuseManifest(
  root: ReturnType<typeof validateParentManifest>,
  {
    runId = "29090000001",
    selectedRunId = root.runId,
    targetSha = root.targetSha,
    changedPaths = [],
    policy = "exact-target-full-validation-v1",
  }: {
    runId?: string;
    selectedRunId?: string;
    targetSha?: string;
    changedPaths?: string[];
    policy?: string;
  } = {},
) {
  return manifestFixture({
    evidenceReuse: {
      changedPaths,
      evidenceSha: root.targetSha,
      policy,
      runId: root.runId,
      selectedRunId,
    },
    runId,
    targetSha,
  });
}

function publicationSourceFixture(
  fixture: ReturnType<typeof trustedMainNpmFixture>,
  fullCoverage: boolean,
  route: "normal" | "prepared" = "normal",
  legacyArtifactInput = false,
) {
  const request = publicationSourceRequest({
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
  });
  return createPublicationSourceFact(
    {
      ...request,
      coverage: {
        ...request.coverage,
        ...(legacyArtifactInput && { publication_artifact_source_json: "", telegram_waiver: "" }),
      },
    },
    { packages: [], platforms: [] },
    {
      version: "2026.8.28-beta.1",
      packages: [{ name: "openclaw", version: "2026.8.28-beta.1", targets: ["npm"] }],
      platforms: [],
    },
  );
}

function publicationRestoreFixture(
  fullCoverage = false,
  route: "normal" | "prepared" = "normal",
  legacyArtifactInput = false,
) {
  const fixture = trustedMainNpmFixture();
  const source = publicationSourceFixture(fixture, fullCoverage, route, legacyArtifactInput);
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
    "cached",
    "artifact",
    "legacy-empty-operand",
    "nonempty-retired-operand",
    "wrong-producer",
    "wrong-attempt",
  ] as const)(
    "authenticates a %s plan against its later pre-seal recovery attempt",
    async (planSource) => {
      const fixture = publicationRestoreFixture(
        false,
        "normal",
        planSource === "legacy-empty-operand",
      );
      const {
        publication_artifact_source_json: _retired,
        telegram_waiver: _telegram,
        ...coverage
      } = fixture.request.coverage;
      fixture.plan.sealParentRunAttempt = planSource === "wrong-attempt" ? 3 : 2;
      fixture.plan.sha256 = releaseExecutionPlanSha256(fixture.plan);
      const parent = publicationParent(fixture);
      const resolveJob = Object.assign(makeJob("Resolve target ref", { id: 901 }), {
        steps: [{ name: "Finalize publication admission", conclusion: "success" }],
      });
      const sealer = Object.assign(
        makeJob("Seal release execution plan", { id: 902, run_attempt: 2 }),
        {
          steps: [...publicationPlanSteps(), planDigestStep()],
        },
      );
      const client = {
        getRunAttempt: async () => parent,
        getWorkflowSource: () =>
          'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n  FULL_RELEASE_EXECUTION_PLAN_RESTORE_CONTRACT: "1"\n',
        getRunAttemptJobs: async (_runId: string, attempt: number) =>
          attempt === 1 ? [resolveJob] : [sealer],
        getJobLog: async () =>
          `2026-08-28T12:01:03.750Z FRV_EXECUTION_PLAN_SHA256=${fixture.plan.sha256}\n`,
        loadExecutionPlanEvidence: vi.fn(() => {
          if (planSource === "cached") {
            throw new Error("authenticated cache must avoid artifact download");
          }
          return {
            plan: fixture.plan,
            artifact: {
              workflow_run: {
                head_sha: planSource === "wrong-producer" ? "d".repeat(40) : parent.head_sha,
                head_branch: parent.head_branch,
              },
            },
          };
        }),
      };
      const operation = restoreOriginalPublicationAdmission({
        request: {
          ...fixture.request,
          coverage:
            planSource === "nonempty-retired-operand"
              ? { ...coverage, telegram_waiver: "changed" }
              : coverage,
        },
        client,
        cachedPlan: planSource === "cached" ? fixture.plan : undefined,
      });
      if (planSource === "wrong-producer") {
        await expect(operation).rejects.toThrow("artifact producer mismatch");
        return;
      }
      if (planSource === "wrong-attempt") {
        await expect(operation).rejects.toThrow("sealer/upload did not succeed");
        return;
      }
      if (planSource === "nonempty-retired-operand") {
        await expect(operation).rejects.toThrow(
          "publication original admission operands differ from this attempt",
        );
        return;
      }
      const restored = await operation;
      expect(restored.plan).toEqual(fixture.plan);
      expect(client.loadExecutionPlanEvidence).toHaveBeenCalledTimes(
        planSource === "cached" ? 0 : 1,
      );
    },
  );

  it.for([
    "cached-plan-mutated",
    "cached-plan-missing-witness",
    "cached-plan-outside-witness",
    "cached-plan-failed-witness",
    "cached-plan-historical",
    "reuploaded-plan",
    "failed-sealer",
    "failed-resolution",
    "duplicate-sealer",
    "skipped-seal",
    "failed-upload",
    "late-artifact",
    "upload-before-seal",
    "wrong-repository",
    "wrong-attempt",
    "wrong-workflow",
    "wrong-sha",
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
    if (fault === "cached-plan-mutated") {
      const row = expectDefined(fixture.admission.observations.npm[0], "root observation");
      if (row.outcome !== "observed") {
        throw new Error("fixture root observation unavailable");
      }
      row.state.latestVersion = "2026.8.27";
      fixture.admission.binding.observationsDigest = `sha256:${createHash("sha256").update(publicationObservationJson(fixture.admission.observations)).digest("hex")}`;
      fixture.plan.sha256 = releaseExecutionPlanSha256(fixture.plan);
    }
    const root = tempDirs.make("publication-original-reader-");
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
        total_count: fault === "duplicate-sealer" ? 3 : 2,
        jobs: [
          {
            id: 999,
            name: "Resolve target ref",
            run_attempt: 1,
            status: "completed",
            conclusion: fault === "failed-resolution" ? "failure" : "success",
            steps: [{ name: "Finalize publication admission", conclusion: "success" }],
          },
          ...Array.from({ length: fault === "duplicate-sealer" ? 2 : 1 }, (_, index) => ({
            id: 1000 + index,
            name: "Seal release execution plan",
            run_attempt: 1,
            status: "completed",
            conclusion: fault === "failed-sealer" ? "failure" : "success",
            steps: [
              ...publicationPlanSteps(
                fault === "skipped-seal"
                  ? "skipped"
                  : fault === "failed-sealer"
                    ? "failure"
                    : "success",
                fault === "failed-upload" ? "failure" : "success",
                fault === "upload-before-seal" ? 4 : 6,
              ),
              ...(witnessContract
                ? [planDigestStep(fault === "cached-plan-failed-witness" ? "failure" : "success")]
                : []),
            ],
          })),
        ],
      },
      listing: { total_count: fault === "incomplete-list" ? 2 : artifacts.length, artifacts },
      artifact,
      log:
        fault === "cached-plan-missing-witness"
          ? "2026-08-28T12:01:03.750Z unrelated output\n"
          : `${fault === "cached-plan-outside-witness" ? "2026-08-28T12:01:02.750Z" : "2026-08-28T12:01:03.750Z"} FRV_EXECUTION_PLAN_SHA256=${originalPlanDigest}\n`,
    };
    const { command: gh, calls: callsPath } = ghFixture(root, {
      [`repos/openclaw/openclaw/actions/runs/${fixture.runId}/attempts/1`]: fixtures.parent,
      [`repos/openclaw/openclaw/actions/runs/${fixture.runId}/attempts/1/jobs?*`]: fixtures.jobs,
      [`repos/openclaw/openclaw/contents/${workflowPath}?ref=${fixture.workflowSha}`]:
        fixtures.workflow,
      [`repos/openclaw/openclaw/actions/runs/${fixture.runId}/artifacts?*`]: fixtures.listing,
      "repos/openclaw/openclaw/actions/jobs/1000/logs": fixtures.log,
      "repos/openclaw/openclaw/actions/artifacts/456": artifact,
      "repos/openclaw/openclaw/actions/artifacts/456/zip": archive,
    });
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { restoreOriginalPublicationAdmission } from ${JSON.stringify(pathToFileURL(resolve(SCRIPT)).href)};
const restored = await restoreOriginalPublicationAdmission({ request: ${JSON.stringify(fixture.request)}${cachedRestore ? ", cachedPlan: " + JSON.stringify(fixture.plan) : ""} });
process.stdout.write(JSON.stringify(restored));`,
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
    const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";
    expect(calls).not.toContain("registry.npmjs.org");
    expect(calls).not.toContain("clawhub.ai");
    expect(calls).not.toContain("auth");
    expect(calls).not.toContain("/444");
    if (fault === "reuploaded-plan" || fault === "failed-sealer") {
      expect(result.status, result.stderr).toBe(0);
      const restored = JSON.parse(result.stdout);
      expect(restored.source).toEqual(fixture.source);
      expect(restored.admission).toEqual(fixture.admission);
      expect(restored.plan.sha256).toBe(fixture.plan.sha256);
    } else {
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});

describe("GitHub API commands", () => {
  it.each(["valid", "truncated", "wrong digest"])(
    "verifies a release-sized promotion within the publisher request budget: %s",
    (fault) => {
      const directory = tempDirs.make("release-promotion-batch-");
      const shim = join(directory, "gh");
      writeFileSync(
        shim,
        `#!${process.execPath}\n` +
          String.raw`
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const source = (expression) => {
  const text = JSON.stringify({ name: "openclaw", version: expression.startsWith("a".repeat(40)) ? "2026.11.24-beta.2" : "2026.11.24" });
  return { text, byteSize: Buffer.byteLength(text), oid: createHash("sha1").update("blob " + Buffer.byteLength(text) + "\0" + text).digest("hex"), isBinary: false, isTruncated: false };
};
if (args[1] === "graphql") {
  const query = args.find((arg) => arg.startsWith("query="));
  const repository = Object.fromEntries([...query.matchAll(/f(\d+):object\(expression:"([a-z0-9:/.-]+)"\)/gu)].map((match) => {
    const blob = source(match[2]);
    if (process.env.BLOB_FAULT === "truncated") blob.isTruncated = true;
    if (process.env.BLOB_FAULT === "wrong digest") blob.oid = "0".repeat(40);
    return ["f" + match[1], blob];
  }));
  process.stdout.write(JSON.stringify({ data: { repository } }));
} else {
  const blob = source("a".repeat(40));
  process.stdout.write(JSON.stringify({ type: "file", path: "package.json", encoding: "base64", size: blob.byteSize, sha: blob.oid, content: Buffer.from(blob.text).toString("base64") }));
}
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import { classifyReleaseEvidenceComparison } from ${JSON.stringify(pathToFileURL(resolve("scripts/full-release-validation-policy.mjs")).href)};
import { createReleaseEvidenceClient } from ${JSON.stringify(pathToFileURL(resolve(SCRIPT)).href)};
import { withGithubRequestBudget } from ${JSON.stringify(pathToFileURL(resolve("scripts/lib/plain-gh.mjs")).href)};
const client = createReleaseEvidenceClient("openclaw/openclaw");
withGithubRequestBudget(32, (budget) => {
  const files = ["package.json", ...Array.from({ length: 188 }, (_, index) => "extensions/plugin-" + index + "/package.json")].map((filename) => ({ filename, status: "modified" }));
  const result = classifyReleaseEvidenceComparison({ status: "ahead", merge_base_commit: { sha: "a".repeat(40) }, files }, {
    baseSha: "a".repeat(40), targetSha: "b".repeat(40), version: "2026.11.24", targetCoveragePolicy: "npm-stable-v1",
    rootManifest: { releaseProfile: "stable", runReleaseSoak: "true", controls: { performanceBlocking: true }, validationInputs: { targetVersion: "2026.11.24-beta.2" } },
    readSourceFile: (sha, path) => client.getSourceFile(sha, path), readSourceFiles: (requests) => client.getSourceFiles(requests),
  });
  process.stdout.write(JSON.stringify({ policy: result.policy, paths: result.changedPaths.length, requests: budget.used }));
});`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
            BLOB_FAULT: fault,
          },
        },
      );
      if (fault === "valid") {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          policy: "stable-qualified-beta-final-v1",
          paths: 189,
          requests: 13,
        });
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          fault === "truncated"
            ? "invalid immutable promotion source blob"
            : "immutable promotion source blob mismatch",
        );
      }
    },
  );

  it.skipIf(!hasUnzip).each(["summary", "watch", "reuse", "unwaived", "corrupt-policy"])(
    "authenticates Q-only selected-job waivers in the ordinary CLI: %s",
    (scenario) => {
      const directory = tempDirs.make("release-ci-summary-q-policy-");
      const fixture = trustedMainPackageFixture({
        manifestVersion: 3,
        workflowSha: "b".repeat(40),
      });
      const child = expectDefined(
        expectedChildDispatches(fixture.runId, 1, "main").find(
          (entry) => entry.manifestKey === "normalCi",
        ),
        "CI child",
      );
      fixture.parentJob.name = child.parentJobName;
      Object.assign(fixture.childRun, {
        conclusion: "failure",
        display_title: child.displayTitle,
        path: ".github/workflows/ci.yml",
      });
      const jobs = [
        {
          name: "synthetic-selected-test",
          status: "completed",
          conclusion: "failure",
          run_attempt: 1,
        },
      ];
      const composite = composeReleaseAttemptJobs([{ runAttempt: 1, jobs }], {
        effectiveRunAttempt: 1,
        plannedRunAttempt: 1,
      });
      const manifest = {
        ...fixture.manifest,
        rerunGroup: "ci",
        childRuns: {
          ...fixture.manifest.childRuns,
          normalCi: String(fixture.childRun.id),
          releaseChecks: "",
        },
        childEvidence: {
          normalCi: {
            compositeJobsSha256: composite.sha256,
            dispatchActor: "github-actions[bot]",
            effectiveRunAttempt: 1,
            jobs: composite.jobs,
            observedRunAttempts: [1],
            plannedRunAttempt: 1,
            repository: "openclaw/openclaw",
            runId: String(fixture.childRun.id),
            triggeringActor: "github-actions[bot]",
          },
        },
        validationInputs: { ...fixture.manifest.validationInputs, targetVersion: "2099.1.1" },
      };
      const runId = scenario === "reuse" ? "29071366026" : fixture.runId;
      const route = "repos/openclaw/openclaw/";
      const replies: Record<string, unknown> = {
        rate_limit: { resources: { core: { limit: 5000, remaining: 4999, reset: 2_000_000_000 } } },
        [route + "actions/runs/" + fixture.runId + "/jobs?*"]: { jobs: [fixture.parentJob] },
        [route + "actions/runs/" + fixture.childRun.id]: fixture.childRun,
        [route + "actions/jobs/" + fixture.parentJob.id + "/logs"]:
          "TARGET_SHA: " +
          fixture.targetSha +
          "\nDispatched: " +
          fixture.childRun.html_url +
          " (attempt 1)",
      };
      for (const id of scenario === "reuse" ? [fixture.runId, runId] : [runId]) {
        const sha = id === fixture.runId ? fixture.workflowSha : "c".repeat(40);
        const current = {
          ...manifest,
          runId: id,
          workflowSha: sha,
          ...(id === fixture.runId
            ? {}
            : {
                evidenceReuse: {
                  runId: fixture.runId,
                  selectedRunId: fixture.runId,
                  evidenceSha: fixture.targetSha,
                  changedPaths: [],
                  policy: "exact-target-full-validation-v1",
                },
              }),
        };
        const archive = makeStoredZip({ [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(current) });
        const artifact = {
          ...fixture.artifact,
          id: Number(id),
          name: "full-release-validation-" + id + "-1",
          digest: artifactDigest(archive),
          size_in_bytes: archive.length,
          workflow_run: { ...fixture.artifact.workflow_run, id: Number(id), head_sha: sha },
        };
        const policyPath = "scripts/lib/release-validation-waivers.json";
        const policy = Buffer.from(
          JSON.stringify({
            schema: "openclaw.release-validation-waivers/v1",
            waivers:
              scenario === "unwaived"
                ? []
                : [
                    {
                      targetVersion: "2099.1.1",
                      childRole: "normalCi",
                      jobName: "synthetic-selected-test",
                      reason: "Synthetic Q-only grant",
                    },
                  ],
          }),
        );
        Object.assign(replies, {
          ["run view " + id]: { ...fixture.parentView, headSha: sha },
          [route + "actions/runs/" + id]: { ...fixture.parentRun, id: Number(id), head_sha: sha },
          [route + "actions/runs/" + id + "/artifacts?*"]: { artifacts: [artifact] },
          [route + "actions/artifacts/" + id]: artifact,
          [route + "actions/artifacts/" + id + "/zip"]: archive,
          [route + "contents/" + policyPath + "?ref=" + sha]: {
            path: policyPath,
            type: "file",
            encoding: "base64",
            content: policy.toString("base64"),
            size: policy.length,
            sha:
              scenario === "corrupt-policy"
                ? "0".repeat(40)
                : createHash("sha1")
                    .update("blob " + policy.length + "\0")
                    .update(policy)
                    .digest("hex"),
          },
        });
      }
      const { command } = ghFixture(directory, replies);
      const result = spawnSync(
        process.execPath,
        [SCRIPT, runId, ...(scenario === "watch" ? ["--watch"] : [])],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: directory + ":" + (process.env.PATH ?? ""),
            OPENCLAW_GH_BIN: command,
            GH_TOKEN: "synthetic-token",
          },
        },
      );
      const error =
        scenario === "unwaived"
          ? "failed selected job evidence"
          : scenario === "corrupt-policy"
            ? "source-admission workflow blob mismatch"
            : undefined;
      expect(result.status, result.stderr).toBe(error ? 1 : 0);
      if (error) {
        expect(result.stderr).toContain(error);
      } else {
        expect(result.stdout).toContain("child: " + fixture.childRun.id + " CI completed/failure");
        if (scenario === "reuse") {
          expect(result.stdout).toContain("evidence-root-run: " + fixture.runId);
        }
      }
    },
  );

  it("budgets large artifact downloads for a conservative transfer rate", () => {
    expect(artifactDownloadTimeoutMs(55 * 1024 * 1024)).toBeGreaterThan(60_000);
    expect(artifactDownloadTimeoutMs(245 * 1024 * 1024)).toBeGreaterThan(15 * 60_000);
    expect(() => artifactDownloadTimeoutMs(0)).toThrow("artifact download size is invalid");
  });

  it.skipIf(!hasUnzip)(
    "routes evidence reads through cached GitHub and downloads through plain GitHub",
    () => {
      const root = tempDirs.make("release-ci-gh-routing-");
      const fixture = trustedMainPackageFixture();
      const { runId, workflowSha, targetSha } = fixture;
      const childRunId = String(fixture.childRun.id);
      const artifactId = fixture.artifact.id;
      const verifierSha = "c".repeat(40);
      const archive = makeStoredZip({
        [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(fixture.manifest),
      });
      Object.assign(fixture.artifact, {
        digest: artifactDigest(archive),
        size_in_bytes: archive.length,
      });
      const lineage = { merge_base_commit: { sha: workflowSha }, status: "ahead" };
      const policy = Buffer.from(
        '{"schema":"openclaw.release-validation-waivers/v1","waivers":[]}',
      );
      const policyPath = "scripts/lib/release-validation-waivers.json";
      const { calls: shimLog } = ghFixture(root, {
        "run view": fixture.parentView,
        "auth token": "wrapper-only-token",
        rate_limit: { resources: { core: { limit: 5000, remaining: 4999, reset: 2_000_000_000 } } },
        ["repos/openclaw/openclaw/contents/" + policyPath + "?ref=" + workflowSha]: {
          path: policyPath,
          type: "file",
          encoding: "base64",
          size: policy.length,
          content: policy.toString("base64"),
          sha: createHash("sha1")
            .update("blob " + policy.length + "\0")
            .update(policy)
            .digest("hex"),
        },
        [`repos/openclaw/openclaw/actions/runs/${runId}`]: fixture.parentRun,
        [`repos/openclaw/openclaw/actions/runs/${runId}/artifacts?*`]: {
          artifacts: [fixture.artifact],
        },
        [`repos/openclaw/openclaw/actions/artifacts/${artifactId}`]: fixture.artifact,
        [`repos/openclaw/openclaw/actions/runs/${runId}/jobs?*`]: { jobs: [fixture.parentJob] },
        [`repos/openclaw/openclaw/actions/runs/${childRunId}`]: fixture.childRun,
        [`repos/openclaw/openclaw/actions/jobs/${fixture.parentJob.id}/logs`]: `TARGET_SHA: ${targetSha}\nDispatched: https://github.com/openclaw/openclaw/actions/runs/${childRunId} (attempt 1)`,
        [`repos/openclaw/openclaw/compare/${workflowSha}...${verifierSha}?per_page=1&page=2`]:
          lineage,
      });
      const plainLog = join(root, "plain.log");
      const archivePath = join(root, "manifest.zip");
      const plainGh = join(root, "plain-gh");
      writeFileSync(archivePath, archive);
      writeFileSync(
        plainGh,
        `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(plainLog)}, JSON.stringify(args) + "\\n");
if (process.env.GH_TOKEN !== "wrapper-only-token") throw new Error("missing wrapper authentication");
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(["api", `repos/openclaw/openclaw/actions/artifacts/${artifactId}/zip`]))}) throw new Error("plain gh used for evidence read");
process.stdout.write(fs.readFileSync(${JSON.stringify(archivePath)}));
`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_GH_BIN: plainGh,
        PATH: `${root}:${process.env.PATH ?? ""}`,
      };
      for (const key of [
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
      ]) {
        delete env[key];
      }
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
      expect(JSON.parse(lineageResult.stdout)).toEqual(lineage);
      const result = spawnSync(process.execPath, [SCRIPT, runId], { encoding: "utf8", env });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `child: ${childRunId} OpenClaw Release Checks completed/success`,
      );
      expect(result.stdout).not.toContain("Advisory lane failed");
      const shimCalls = readFileSync(shimLog, "utf8");
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
      expect(readFileSync(plainLog, "utf8").trim()).toBe(
        JSON.stringify(["api", `repos/openclaw/openclaw/actions/artifacts/${artifactId}/zip`]),
      );
      const acquire = (attempt: number) =>
        spawnSync(
          process.execPath,
          [
            SCRIPT,
            "--acquire-publication-manifest",
            runId,
            "--expected-run-attempts-json",
            JSON.stringify({ [runId]: attempt }),
          ],
          { encoding: "utf8", env },
        );
      const acquired = acquire(fixture.parentRun.run_attempt);
      expect(acquired.stderr).toBe("");
      expect(acquired.status).toBe(0);
      expect(JSON.parse(acquired.stdout)).toEqual(fixture.manifest);
      const staleAttempt = acquire(fixture.parentRun.run_attempt + 1);
      expect(staleAttempt.status).not.toBe(0);
      expect(staleAttempt.stderr).toMatch(/attempt/i);
    },
  );
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

  it("retries once without the flag for the exact legacy gh error", () => {
    const { calls, result } = runParentJobLogProbe(`
if (args.includes("--allow-escape-sequences")) {
  process.stderr.write("unknown flag: --allow-escape-sequences\\n\\nUsage: gh api <endpoint> [flags]\\n");
  process.exit(1);
}
process.stdout.write("\\u001b[31mlegacy log\\u001b[0m");
`);

    expect(result).toMatchObject({
      status: 0,
      stderr: "",
      stdout: "\u001b[31mlegacy log\u001b[0m",
    });
    expect(calls).toEqual([flaggedArgs, legacyArgs]);
  });

  it("propagates unrelated errors without retrying", () => {
    const { calls, result } = runParentJobLogProbe(`
process.stderr.write("error: unknown flag: --allow-escape-sequences\\n");
process.exit(1);`);

    expect(result).toMatchObject({ status: 17, stderr: "" });
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

function artifactDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type ReleaseCiWatchState = {
  attempt: number;
  conclusion: string;
  jobs: Array<{ conclusion: string; name: string; status: string; url?: string }>;
  status: string;
  url?: string;
};

function verifyFixture(
  fixture: Pick<
    ReturnType<typeof trustedMainPackageFixture> | ReturnType<typeof trustedMainNpmFixture>,
    "runId" | "client"
  >,
) {
  return validateReleaseRunEvidence(verifierOptions(fixture.runId), fixture.client);
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
  it.each([2, 3, 4] as const)(
    "rejects unadmitted v%s qualification with actionable recovery guidance",
    async (version) => {
      const fixture =
        version === 4
          ? trustedMainNpmFixture()
          : trustedMainPackageFixture({ manifestVersion: version });
      await expect(verifyFixture(fixture)).rejects.toThrow(
        "Release qualification requires authenticated P admission; obtain new admitted qualification",
      );
    },
  );
  it.each(["", " / Watch"])(
    "reports an early release blocker once while the diagnostic drain continues%s",
    (suffix) => {
      const fixture = createReleaseCiWatchFixture([
        {
          attempt: 1,
          conclusion: "",
          jobs: [
            { conclusion: "failure", name: "Release Decision" + suffix, status: "completed" },
            { conclusion: "", name: "Diagnostic Drain" + suffix, status: "in_progress" },
          ],
          status: "in_progress",
        },
      ]);
      try {
        const result = fixture.run();
        const calls = fixture.readCalls();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "Full Release Validation state: blocked_diagnostics_running",
        );
        expect(result.stderr).toContain("Diagnostic Drain is still collecting terminal evidence");
        expect(
          calls.filter(
            (args) =>
              args[0] === "run" &&
              args[args.indexOf("--json") + 1] === "status,conclusion,attempt,headSha,jobs",
          ),
        ).toHaveLength(1);
        expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(
          1,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

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
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
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
      makeJob(child.parentJobName, {
        id: 900,
        completed_at: "2026-08-22T00:01:00Z",
        started_at: "2026-08-22T00:00:00Z",
      }),
      makeJob(child.parentJobName, {
        id: 901,
        run_attempt: 2,
        completed_at: "2026-08-22T00:02:00Z",
        started_at: "2026-08-22T00:01:00Z",
      }),
    ];

    expect(() =>
      selectManifestParentJob(parentJobs, child, parentManifest, 1, {
        requireSkippedCarryForward: true,
      }),
    ).toThrow("manifest parent job was redispatched during recovery");
  });

  it("collects admitted child evidence concurrently and drains reads after failure", async () => {
    const f = candidatePublicationFixture();
    let active = 0;
    let peak = 0;
    let completed = 0;
    await expect(
      validateReleaseRunEvidence(candidateVerifierOptions(f), {
        ...f.client,
        async getJobLog(jobId: number) {
          if (jobId === 902) {
            return f.client.getJobLog(jobId);
          }
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((complete) => {
            setImmediate(complete);
          });
          active -= 1;
          completed += 1;
          if (jobId === 201) {
            throw new Error("dispatch log unavailable");
          }
          return f.client.getJobLog(jobId);
        },
      }),
    ).rejects.toThrow("dispatch log unavailable");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(7);
    expect(completed).toBe(f.plan.children.length);
    expect(active).toBe(0);
  });

  it("recomputes admitted child retries and rejects stale or forged composite evidence", async () => {
    const f = candidatePublicationFixture();
    const child = expectDefined(
      f.plan.children.find((entry) => entry.key === "normalCi"),
      "CI child",
    );
    const jobs = await f.client.getRunAttemptJobs(child.runId);
    const gate = expectDefined(
      jobs.find((job) => job.name === "openclaw/ci-gate"),
      "CI gate",
    );
    const originalJobs = jobs.map((job) =>
      job === gate ? { ...job, conclusion: "failure" } : job,
    );
    const retryJobs = [{ ...gate, run_attempt: 2 }];
    const evidence = attemptEvidence(child.runId, [
      { runAttempt: 1, jobs: originalJobs },
      { runAttempt: 2, jobs: retryJobs },
    ]);
    f.manifest.childEvidence.normalCi = evidence;
    const client = {
      ...f.client,
      getRun: async (id: string) => {
        const run = await f.client.getRun(id);
        return id === child.runId
          ? { ...run, run_attempt: 2, triggering_actor: { login: "release-operator" } }
          : run;
      },
      getRunAttemptJobs: async (id: string, attempt: number) =>
        id === child.runId
          ? attempt === 1
            ? originalJobs
            : retryJobs
          : f.client.getRunAttemptJobs(id),
    };
    const result = await validateReleaseRunEvidence(candidateVerifierOptions(f), client);
    expect(result.children).toContainEqual(
      expect.objectContaining({
        role: "normalCi",
        plannedRunAttempt: 1,
        runAttempt: 2,
        compositeJobsSha256: evidence.compositeJobsSha256,
      }),
    );
    f.manifest.childEvidence.normalCi = attemptEvidence(child.runId, [{ runAttempt: 1, jobs }]);
    await expect(
      validateReleaseRunEvidence(candidateVerifierOptions(f), {
        ...client,
        getRunAttemptJobs: async (id: string, attempt: number) =>
          id === child.runId && attempt === 1 ? jobs : client.getRunAttemptJobs(id, attempt),
      }),
    ).rejects.toThrow("successful parent manifest predates CI attempt 2");
    f.manifest.childEvidence.normalCi = evidence;
    expectDefined(evidence.jobs[0], "composite job").conclusion = "failure";
    await expect(validateReleaseRunEvidence(candidateVerifierOptions(f), client)).rejects.toThrow(
      "digest is invalid",
    );
  });

  it.each(["failed-gate", "missing-gate", "skipped-gate", "windows-shard", "retired-advisory"])(
    "keeps admitted candidate qualification strict for %s",
    async (scenario) => {
      const f = candidatePublicationFixture();
      const selected = expectDefined(
        f.plan.children.find((child) => child.key === "normalCi"),
        "frozen normal CI child",
      );
      const originalJobs = await f.client.getRunAttemptJobs(selected.runId);
      const gate = expectDefined(
        originalJobs.find((job) => job.name === "openclaw/ci-gate"),
        "CI gate",
      );
      const jobs = [
        ...originalJobs,
        {
          ...gate,
          id: 1599,
          name: "CI preflight",
          html_url: `https://github.com/openclaw/openclaw/actions/runs/${selected.runId}/job/1599`,
        },
      ].flatMap((job) => {
        if (job.name !== gate.name) {
          return [job];
        }
        if (scenario === "missing-gate") {
          return [];
        }
        return [
          {
            ...job,
            conclusion:
              scenario === "failed-gate"
                ? "failure"
                : scenario === "skipped-gate"
                  ? "skipped"
                  : job.conclusion,
          },
        ];
      });
      if (scenario === "windows-shard") {
        jobs.push({
          ...gate,
          id: 1501,
          name: "checks-windows-node-test-2",
          conclusion: "failure",
        });
      }
      const composite = composeReleaseAttemptJobs([{ jobs, runAttempt: 1 }], {
        effectiveRunAttempt: 1,
        plannedRunAttempt: 1,
      });
      Object.assign(expectDefined(f.manifest.childEvidence.normalCi, "frozen CI evidence"), {
        jobs: composite.jobs,
        compositeJobsSha256: composite.sha256,
      });
      if (scenario === "retired-advisory") {
        Object.assign(f.manifest, {
          advisoryJobs: [{ class: "recorded-flake", child: "normalCi" }],
        });
      }
      const before = JSON.stringify(f.manifest);
      await expect(
        validateReleaseRunEvidence(
          {
            repository: f.repository,
            runId: f.runId,
            trustedWorkflowRef: f.publisherFullRef.slice("refs/tags/".length),
            trustedWorkflowFullRef: f.publisherFullRef,
            trustedWorkflowSha: f.p,
            verifierSourceSha: f.p,
            verifierSourceContent: readFileSync(SCRIPT),
          },
          {
            ...f.client,
            getRunAttemptJobs: async (id: string) =>
              id === selected.runId ? jobs : f.client.getRunAttemptJobs(id),
          },
        ),
      ).rejects.toThrow(
        scenario === "retired-advisory"
          ? /advisory jobs differ/u
          : scenario === "windows-shard"
            ? /manifest child run does not pass release policy/u
            : /openclaw\/ci-gate/u,
      );
      expect(JSON.stringify(f.manifest)).toBe(before);
    },
  );

  it("reads published empty retry metadata without granting an advisory", async () => {
    const fixture = trustedMainNpmFixture();
    const selected = expectDefined(
      fixture.executionPlan.children.find((child) => child.key === "releaseChecksCandidate"),
      "release checks child",
    );
    const jobs = [
      {
        name: "cross_os_release_checks / Windows / packaged upgrade",
        status: "completed",
        conclusion: "failure",
      },
      {
        name: "cross_os_release_checks / macOS / packaged fresh",
        status: "completed",
        conclusion: "success",
      },
      { name: "Verify release checks", status: "completed", conclusion: "success" },
    ].map((job) => Object.assign({}, fixture.parentJob, job));
    const composite = composeReleaseAttemptJobs([{ jobs, runAttempt: 1 }], {
      plannedRunAttempt: 1,
      effectiveRunAttempt: 1,
    });
    Object.assign(
      expectDefined(fixture.manifest.childEvidence.releaseChecksCandidate, "child evidence"),
      {
        jobs: composite.jobs,
        compositeJobsSha256: composite.sha256,
      },
    );
    Object.assign(fixture.executionPlan, {
      knownFlakyJobs: [],
    });
    fixture.executionPlan.sha256 = releaseExecutionPlanSha256(fixture.executionPlan);
    Object.assign(fixture.manifest.validationInputs, {
      knownFlakyJobsJson: "[]",
    });
    const manifest = Object.assign(fixture.manifest, {
      knownFlakyJobs: [],
      automaticRetries: [],
      executionPlanSha256: fixture.executionPlan.sha256,
      advisoryJobs: jobs.slice(0, 2).map(({ name, status, conclusion }) => ({
        child: selected.key,
        job: name,
        status,
        conclusion,
        policy: "advisory",
      })),
    });
    const before = JSON.stringify(manifest);
    expect(() => validateParentManifest(manifest, { runId: fixture.runId })).toThrow(
      "advisory jobs differ",
    );
    expect(JSON.stringify(manifest)).toBe(before);
  });

  it("returns structured CLI failure when the verifier source is unavailable", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--validate-run", "1", "--verifier-source-sha", "f".repeat(40), "--json"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      error: "release evidence verifier source blob is unavailable",
      schema: "openclaw.release-validation-evidence/v4",
      valid: false,
    });
  });

  it("rejects dirty verifier bytes and a forged verifier source SHA", async () => {
    const fixture = trustedMainPackageFixture();
    await expect(
      validateReleaseRunEvidence(
        {
          ...verifierOptions(fixture.runId),
          repository: "openclaw/openclaw",
          verifierSourceContent: "different verifier bytes",
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

  it("keeps historical QA manifests readable", () => {
    const manifest = manifestFixture({ rerunGroup: "qa", version: 3, workflowSha: "b".repeat(40) });
    expect(manifest).toMatchObject({ rerunGroup: "qa", version: 3 });
  });
  it("binds v3 manifests to their immutable producer workflow SHA", () => {
    const workflowSha = "b".repeat(40);
    const manifest = manifestFixture(
      { version: 3, workflowSha },
      { workflowRef: "main", workflowSha },
    );
    expect(manifest).toMatchObject({
      version: 3,
      workflowSha,
    });
    expect(() =>
      manifestFixture({ version: 3, workflowSha }, { workflowSha: "c".repeat(40) }),
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
    const expected = { candidateBinding, repository: "openclaw/openclaw", workflowSha };
    const manifest = manifestFixture({ candidateBinding, version: 3, workflowSha }, expected);
    expect(manifest.candidateBinding).toEqual(candidateBinding);
    expect(() =>
      manifestFixture({ candidateBinding: null, version: 3, workflowSha }, expected),
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
    const qualified = requiredChildKeysForRerunGroup("qualified-package", {}, 3);
    expect(qualified).toEqual(new Set(["releaseChecksCandidate"]));
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

  it.each([
    "beta profile",
    "full profile",
    "missing soak",
    "advisory performance",
    "different final",
    "dependency change",
    "conditional export order",
    "source change",
    "foreign notes",
    "renamed file",
    "incomplete comparison",
  ])("rejects unsafe beta-to-final evidence reuse: %s", (fault) => {
    const root = manifestFixture();
    Object.assign(root, {
      releaseProfile:
        fault === "beta profile" ? "beta" : fault === "full profile" ? "full" : "stable",
      runReleaseSoak: fault === "missing soak" ? "false" : "true",
      controls: { ...root.controls, performanceBlocking: fault !== "advisory performance" },
      validationInputs: { ...root.validationInputs, targetVersion: "2026.11.24-beta.2" },
    });
    const current = reuseManifest(root, {
      policy: "stable-qualified-beta-final-v1",
      targetSha: "b".repeat(40),
      changedPaths: ["package.json"],
    });
    current.validationInputs = {
      ...root.validationInputs,
      targetVersion: "2026.11.24",
      coveragePolicy: "npm-stable-v1",
    };
    const files = [{ filename: "package.json", status: "modified" }];
    if (fault === "source change") {
      files.push({ filename: "src/index.ts", status: "modified" });
    }
    if (fault === "foreign notes") {
      files.push({ filename: "CHANGELOG/2026.11.23.md", status: "modified" });
    }
    if (fault === "renamed file") {
      files[0]!.status = "renamed";
    }
    if (fault === "incomplete comparison") {
      for (let index = 1; index < 300; index++) {
        files.push({ filename: `extensions/plugin-${index}/package.json`, status: "modified" });
      }
    }
    expect(() =>
      validateEvidenceReuseChain(
        current,
        root,
        root,
        () => ({ status: "ahead", merge_base_commit: { sha: root.targetSha }, files }),
        (sha: string) =>
          JSON.stringify({
            version:
              sha === root.targetSha
                ? "2026.11.24-beta.2"
                : fault === "different final"
                  ? "2026.11.25"
                  : "2026.11.24",
            dependencies: {
              example: sha !== root.targetSha && fault === "dependency change" ? "2" : "1",
            },
            exports:
              fault === "conditional export order"
                ? {
                    ".":
                      sha === root.targetSha
                        ? { node: "./node.js", default: "./default.js" }
                        : { default: "./default.js", node: "./node.js" },
                  }
                : undefined,
          }),
      ),
    ).toThrow(
      fault === "beta profile" ||
        fault === "full profile" ||
        fault === "missing soak" ||
        fault === "advisory performance"
        ? "stable qualification, soak and blocking performance"
        : fault === "different final"
          ? "versions differ"
          : fault === "dependency change" || fault === "conditional export order"
            ? "non-version changes"
            : fault === "incomplete comparison"
              ? "complete same-base"
              : "product change",
    );
  });

  it("rejects unverified changed paths and cross-SHA exact-target reuse", () => {
    const root = manifestFixture();
    const changedPaths = reuseManifest(root, {
      changedPaths: ["CHANGELOG.md"],
      policy: "changelog-only-release-v1",
      targetSha: "b".repeat(40),
    });
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

    const changedTarget = reuseManifest(root, { targetSha: "b".repeat(40) });
    expect(() => validateEvidenceReuseChain(changedTarget, root, root)).toThrow(
      "exact-target release evidence reuse requires no changed paths",
    );
  });

  it("binds split changelog reuse to the selected release entry and matching record", () => {
    const targetVersion = "2026.7.1-beta.1";

    const inputs = { ...rawManifest({}).validationInputs, targetVersion };
    const root = validateParentManifest(
      { ...rawManifest({}), validationInputs: inputs },
      { runAttempt: 2, runId: "29090000000" },
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
    const betaPaths = [
      "CHANGELOG.md",
      `CHANGELOG/${targetVersion}.md`,
      `CHANGELOG/records/${targetVersion}.md`,
    ];
    expect(validateEvidenceReuseChain(makeCurrent(betaPaths), root, root, compare(betaPaths))).toBe(
      root.targetSha,
    );
    const mixedPaths = [...paths, ...betaPaths.slice(1)];
    expect(() =>
      validateEvidenceReuseChain(makeCurrent(mixedPaths), root, root, compare(mixedPaths)),
    ).toThrow("invalid target delta");
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

    expect(() =>
      validateEvidenceReuseChain(
        makeCurrent(["CHANGELOG.md"]),
        root,
        root,
        compare(["CHANGELOG.md"]),
      ),
    ).toThrow("invalid target delta");
  });

  it("rejects exact-target reuse without matching root policy and authorization", () => {
    const root = manifestFixture();
    const current = reuseManifest(root);
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
    const root = manifestFixture();
    const intermediate = reuseManifest(root);
    const current = reuseManifest(root, {
      runId: "29090000002",
      selectedRunId: intermediate.runId,
    });

    expect(() => validateEvidenceReuseChain(current, intermediate, root)).toThrow(
      "evidence reuse must select a root execution manifest",
    );
  });

  it("binds each manifest workflow ref to the fetched parent branch", () => {
    expect(() => manifestFixture({}, { workflowRef: "release/2026.7.1" })).toThrow(
      "release validation manifest workflow ref mismatch",
    );
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
    const parentJobs = [makeJob(child.parentJobName, { id: 901, run_attempt: 3 })];
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
    const validate = (candidate: typeof run) =>
      validateManifestChildRun(candidate, child, "101", parentManifest, parentJobs, parentLog);
    expect(validate(run)).toBe(run);
    expect(() => validate({ ...run, head_branch: "release/2026.7.1" })).toThrow(
      "manifest child dispatch tuple mismatch",
    );
    expect(() => manifestFixture({}, { runAttempt: 3 })).toThrow(
      "release validation manifest run attempt mismatch",
    );
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
      const validate = (log = parentLog) =>
        validateManifestChildRun(run, child, String(runId), parentManifest, parentJobs, log);
      expect(resolveManifestChildOriginAttempt(run, child, parentManifest, parentJobs)).toBe(
        originAttempt,
      );
      expect(validate()).toBe(run);
      expect(validate(parentLog.replace(` (attempt ${run.run_attempt})`, ""))).toBe(run);
      if (child.manifestKey === "productPerformance") {
        expect(() => validate(parentLog.replace("-f publish_reports=false\n", ""))).toThrow(
          "release performance child is not dispatched in artifact-only mode",
        );
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
    const validate = (candidate: typeof wrongParent) =>
      validateManifestChildRun(candidate, ci, "101", parentManifest, ciJobs, ciLog);
    expect(() => validate(wrongParent)).toThrow("manifest child dispatch tuple mismatch");
    expect(() =>
      validate({
        ...wrongParent,
        display_title: `CI full-release-validation-${parentManifest.runId}-3-ci`,
      }),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(
      resolveManifestChildOriginAttempt({ display_title: "CI nearby" }, ci, parentManifest, ciJobs),
    ).toBeUndefined();
  });

  it("keeps requested changelog reuse target and evidence SHAs separate", () => {
    const evidenceSha = "a".repeat(40);
    const targetSha = "b".repeat(40);
    const current = {
      evidenceReuse: {
        changedPaths: ["CHANGELOG.md"],
        evidenceSha,
        policy: "changelog-only-release-v1",
        runId: "101",
        selectedRunId: "101",
      },
      runId: "101",
      targetSha,
    };
    const options = {
      expectedChangedPaths: ["CHANGELOG.md"],
      expectedEvidencePolicy: "changelog-only-release-v1",
      expectedEvidenceSha: evidenceSha,
      expectedRootRunId: "101",
      expectedSelectedRunId: "101",
      expectedTargetSha: targetSha,
    };
    const validate = (sha: string) =>
      validateRequestedEvidenceReuse(
        current,
        { runId: "101", targetSha: sha },
        { runId: "101", targetSha: sha },
        options,
      );
    expect(() => validate(evidenceSha)).not.toThrow();
    expect(() => validate(targetSha)).toThrow("no longer matches");
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
      makeJob(child.parentJobName, {
        id: 900,
        completed_at: "2026-07-04T20:29:21Z",
        started_at: "2026-07-04T19:53:02Z",
      }),
      makeJob(child.parentJobName, {
        id: 901,
        run_attempt: 2,
        completed_at: "2026-07-04T20:30:21Z",
        started_at: "2026-07-04T19:53:02Z",
      }),
    ];

    expect(() => selectManifestParentJob(parentJobs, child, parentManifest, 1)).toThrow(
      "manifest parent job carry-forward fingerprint mismatch",
    );
  });
});
