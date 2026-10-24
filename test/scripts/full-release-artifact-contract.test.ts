import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, assert, expect, it } from "vitest";
import { parse } from "yaml";
import {
  createPublicationAdmission as createAdmission,
  createPublicationSourceFact as createSource,
  normalizePublicationIntent,
  publicationAdmissionContract,
  publicationIntentInputs,
  publicationObservationJson,
  publicationSourceJson,
  publicationSourceRequest,
  validatePublicationAdmissionBinding as validateAdmission,
  validatePublicationSourceBinding as validateSource,
  type PublicationPlanningSummary,
} from "../../scripts/full-release-publication-contract.mjs";
import { tryReadReleaseDecision } from "../../scripts/full-release-validation-at-sha.mts";
import {
  assertReleasePublicationKnownBudget as assertBudget,
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact as buildPlanArtifact,
  buildReleaseStateArtifact,
  buildReleaseValidationManifest as buildManifest,
  composeReleaseAttemptJobs,
  MAX_RELEASE_ARTIFACT_BYTES,
  serializeReleaseArtifact as serializeArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { manifestContextFromEnvironment } from "../../scripts/lib/full-release-manifest.mjs";
import { tryReadReleaseDecisionArtifact } from "../../scripts/release-ci-summary.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  canonicalCandidateRequest,
  child as releaseChild,
  publicationSourceEnv,
  registryRecord,
} from "./full-release-validation-state.test-support.js";

it.each([
  { route: "alpha", npmDistTag: "alpha" },
  { route: "normal", npmDistTag: "alpha" },
])("rejects retired alpha publication selection %j", (selection) => {
  expect(() =>
    normalizePublicationIntent(
      "publish",
      JSON.stringify({
        ...selection,
        publishOpenclawNpm: true,
        pluginPublishScope: "all-publishable",
        plugins: [],
      }),
    ),
  ).toThrow("Alpha releases are retired;");
});

const SHA = "a".repeat(40);
const directories = useAutoCleanupTempDirTracker(afterEach);
const releaseWorkflow = () =>
  parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const artifactSize = (value: Parameters<typeof serializeArtifact>[0]) =>
  Buffer.byteLength(serializeArtifact(value));
const inventory = { packages: [], platforms: [] };
const registryPlan = (
  overrides: Partial<PublicationPlanningSummary> = {},
): PublicationPlanningSummary => ({
  all: [],
  candidates: [],
  skippedPublished: [],
  warnings: [],
  ...overrides,
});
const pluginPackage = { name: "@openclaw/test", version: "2026.9.9" };

function refreshSource({ source, observations }: ReturnType<typeof registryEvidence>) {
  const { digest: _digest, ...unsigned } = source;
  source.digest = digest(publicationSourceJson(unsigned));
  observations.sourceDigest = source.digest;
}
function sourceProjection() {
  return {
    version: "2026.9.9",
    packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
    platforms: [],
  };
}

function sourceRequest(inputs: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) {
  return publicationSourceRequest(
    publicationSourceEnv(
      { ref: SHA, release_profile: "full", ...inputs },
      {
        PUBLICATION_TOOLING_JSON: JSON.stringify({ fullRef: "refs/heads/main", sha: SHA }),
        GITHUB_REF: "refs/heads/release-ci/test",
        GITHUB_RUN_ID: "123",
        ...env,
      },
    ),
  );
}

function manifestWriterFixture(plan: unknown, drain: unknown = { children: {} }) {
  const writer = releaseWorkflow().jobs.summary.steps.find(
    (step: { name: string }) => step.name === "Write release validation manifest",
  );
  const directory = directories.make("release-manifest-");
  const planPath = join(directory, "plan.json");
  const drainPath = join(directory, "drain.json");
  writeFileSync(planPath, serializeArtifact(plan));
  writeFileSync(drainPath, serializeArtifact(drain));
  return {
    writer,
    directory,
    run(this: void, env: NodeJS.ProcessEnv) {
      const result = spawnSync("bash", ["-c", writer.run], {
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.keys(writer.env).map((key) => [key, ""])),
          PATH: process.env.PATH,
          RELEASE_STATE_SCRIPT: resolve("scripts/full-release-validation-state.mjs"),
          RUNNER_TEMP: directory,
          RELEASE_EXECUTION_PLAN_PATH: planPath,
          DIAGNOSTIC_DRAIN_PATH: drainPath,
          ...env,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(
        join(directory, "full-release-validation/full-release-validation-manifest.json"),
        "utf8",
      );
    },
  };
}

type ReleaseContext = ReturnType<typeof registryBudgetFixture>["context"];
function githubContext(context: ReleaseContext): NodeJS.ProcessEnv {
  return {
    GITHUB_RUN_ID: context.runId,
    GITHUB_RUN_ATTEMPT: context.runAttempt,
    GITHUB_REF_NAME: context.workflowRef,
    GITHUB_SHA: context.workflowSha,
    GITHUB_REF: context.workflowFullRef,
    GITHUB_REF_TYPE: context.workflowRefType,
  };
}

function writerContext(context: ReleaseContext): NodeJS.ProcessEnv {
  return {
    ...githubContext(context),
    TARGET_REF: context.targetRef,
    RELEASE_PROFILE: context.releaseProfile,
    RERUN_GROUP: context.rerunGroup,
    RUN_RELEASE_SOAK: context.runReleaseSoak,
  };
}

function registryEvidence(
  runId = "123",
  warningCount = 0,
  validationInputs: Record<string, string> = {},
  started = "2026-09-13T14:00:00.000Z",
  toolingSha = SHA,
) {
  const source = createSource(
    sourceRequest(validationInputs, {
      GITHUB_RUN_ID: runId,
      GITHUB_SHA: toolingSha,
      PUBLICATION_TOOLING_JSON: JSON.stringify({ fullRef: "refs/heads/main", sha: toolingSha }),
    }),
    inventory,
    sourceProjection(),
  );
  const at = (seconds: number) => new Date(Date.parse(started) + seconds * 1000).toISOString();
  const observations = registryRecord(source).publicationAdmission.observations;
  Object.assign(observations, {
    prerequisitesCompletedAt: started,
    collectionStartedAt: started,
    collectionCompletedAt: at(1),
  });
  const npm = observations.npm[0]!;
  assert(npm.outcome === "observed");
  npm.observedAt = started;
  npm.state.latestVersion = "2026.9.8";
  observations.plans.npm.warnings = Array.from({ length: warningCount }, () => "w".repeat(4000));
  const descriptor = {
    id: "456",
    name: `full-release-publication-observations-${runId}-1`,
    digest: `sha256:${"c".repeat(64)}`,
    sizeInBytes: 2048,
  };
  const admission = createAdmission(source, observations, descriptor, at(2));
  return {
    source,
    observations,
    descriptor,
    admission,
    record: {
      sourceAdmissionContract: "1",
      sourceAdmission: source,
      publicationAdmissionContract: "1",
      publicationAdmission: admission,
    },
  };
}

function registryBudgetFixture(
  warningCount = 0,
  validationInputs: Record<string, string> = {},
  toolingSha = SHA,
) {
  const { record, source } = registryEvidence(
    "123",
    warningCount,
    validationInputs,
    undefined,
    toolingSha,
  );
  const releaseProfile = source.coverage.release_profile;
  const runReleaseSoak = source.coverage.run_release_soak;
  const candidateRequest = canonicalCandidateRequest({
    repository: source.repository,
    targetSha: source.candidateSha,
    toolingSha: source.workflow.sha,
    releaseProfile,
    releaseSoak: runReleaseSoak === "true",
    allowUnreleasedChangelog: source.coverage.allow_unreleased_changelog === "true",
  });
  const inputs = {
    childPhaseVersion: 3,
    parentRunId: "123",
    parentRunAttempt: 1,
    workflowRef: "release-ci/test",
    workflowSha: toolingSha,
    releaseProfile,
    rerunGroup: "all",
    resolveTargetResult: "success",
  };
  const built = buildReleaseExecutionPlan(inputs);
  const plan = buildPlanArtifact({
    ...record,
    ...inputs,
    attemptEvidenceVersion: 3,
    children: built.children,
    gates: built.gates,
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: toolingSha },
    expected: {
      ...inputs,
      repository: source.repository,
      targetSha: source.candidateSha,
      candidateRequest,
    },
  });
  const context = {
    runId: "123",
    runAttempt: "1",
    workflowRef: "release-ci/test",
    workflowFullRef: "refs/heads/release-ci/test",
    workflowRefType: "branch",
    workflowSha: toolingSha,
    targetRef: source.candidateSha,
    releaseProfile,
    rerunGroup: "all",
    runReleaseSoak,
    validationInputs: {},
  };
  return { record, source, plan, context, candidateRequest };
}

it.each(["beta", "stable"])(
  "projects fresh %s performance and Telegram evidence from workflow inputs",
  (releaseProfile) => {
    const telegram = {
      npm_telegram_package_spec: "openclaw@2026.9.9",
      npm_telegram_provider_mode: "live-frontier",
      npm_telegram_scenario: "telegram-status-command",
      skip_package_telegram_e2e: "true",
      allow_unreleased_changelog: "true",
    };
    const { plan, context, source } = registryBudgetFixture(
      0,
      { ...telegram, release_profile: releaseProfile },
      "d".repeat(40),
    );
    expect(plan.evidenceReuse.requested).toBe(false);
    const selectedEnv = Object.fromEntries(
      Object.entries({ ...telegram, release_profile: releaseProfile }).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ]),
    );
    const npmPreflight = {
      source: { sha: context.targetRef },
      producer: { workflowSha: context.workflowSha },
    };
    const projectedContext = manifestContextFromEnvironment(source, {
      ...writerContext(context),
      ...selectedEnv,
      QUALIFIED_NPM_BUNDLE_JSON: JSON.stringify(npmPreflight),
      PREPARED_PLUGIN_NPM_JSON: JSON.stringify({ descriptor: "prepared-plugin-npm" }),
    });
    const manifest = buildManifest({ plan, context: projectedContext });
    expect(manifest.publicationArtifacts).toMatchObject({
      npmPreflight,
      pluginNpm: { descriptor: "prepared-plugin-npm" },
    });
    expect(manifest).toMatchObject({
      releaseProfile,
      controls: {
        stableSoakRequired: releaseProfile !== "beta",
        performanceBlocking: releaseProfile !== "beta",
        performanceReportPublication: "artifact-only",
      },
      childRuns: { productPerformance: { blocking: releaseProfile !== "beta" } },
      validationInputs: {
        npmTelegramPackageSpec: "openclaw@2026.9.9",
        npmTelegramProviderMode: "live-frontier",
        npmTelegramScenario: "telegram-status-command",
        skipPackageTelegramE2e: "true",
        allowUnreleasedChangelog: "true",
      },
    });
    expect(manifest.publicationAdmission).toEqual(plan.publicationAdmission);
    expect(manifest).toHaveProperty(
      "validationInputs.publicationSelectionJson",
      publicationIntentInputs(source).publicationSelectionJson,
    );
  },
);

it.each([
  ["2026-09-13T14:05:00.000Z", true],
  ["2026-09-13T14:05:00.001Z", false],
  ["2026-09-13T13:59:59.999Z", false],
])("checks actual post-upload admission time %s (accepted=%s)", (time, accepted) => {
  const { source, observations, descriptor } = registryEvidence();
  const finalize = () => createAdmission(source, observations, descriptor, time);
  if (accepted) {
    expect(finalize().binding.admittedAt).toBe(time);
  } else {
    expect(finalize).toThrow(/time|freshness/u);
  }
});

function retainedEvidenceFixture() {
  const { record } = registryEvidence();
  const admission = record.publicationAdmission;
  const first = admission.observations.npm[0]!;
  assert(first.outcome === "observed");
  return { record, admission, first };
}

it.each(
  Object.entries({
    "missing-observation": ({ admission }) => (admission.observations.npm = []),
    "extra-required": ({ admission, first }) =>
      admission.observations.npm.push({ ...first, name: "unselected-package" }),
    "empty-history": ({ first }) => (first.state.hasVersionHistory = false),
    "extra-state-field": ({ first }) =>
      Object.assign(first.state, { packageDir: "/private/synthetic/candidate" }),
    "missing-state-field": ({ first }) => Reflect.deleteProperty(first.state, "hasVersionHistory"),
    "future-observation": ({ first }) => (first.observedAt = "2026-09-13T14:00:03.000Z"),
    "changed-content": ({ admission }) => admission.observations.plans.npm.warnings.push("changed"),
    source: ({ admission }) => (admission.binding.sourceDigest = "d".repeat(64)),
    "artifact-attempt": ({ admission }) =>
      (admission.binding.artifact.name = "full-release-publication-observations-123-2"),
    "artifact-digest": ({ admission }) => (admission.binding.artifact.digest = "c".repeat(64)),
    "extra-binding-field": ({ admission }) =>
      Object.assign(admission.binding, { publicationAuthorized: true }),
    "missing-binding": ({ admission }) => Reflect.deleteProperty(admission, "binding"),
    "deleted-contract": ({ record }) =>
      Reflect.deleteProperty(record, "publicationAdmissionContract"),
  } satisfies Record<string, (fixture: ReturnType<typeof retainedEvidenceFixture>) => unknown>),
)("rejects incomplete or altered retained evidence: %s", (_fault, mutate) => {
  const fixture = retainedEvidenceFixture();
  mutate(fixture);
  expect(() => validateAdmission(fixture.record, { publicationAdmissionContract: "1" })).toThrow(
    /publication|observation|registry/u,
  );
});

it("requires exact-source B capability without upgrading A or historical evidence", () => {
  expect(
    publicationAdmissionContract("env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: '1'\n"),
  ).toBeUndefined();
  expect(
    publicationAdmissionContract("env:\n  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: '1'\n"),
  ).toBe("1");
  expect(() =>
    publicationAdmissionContract("env:\n  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: '2'\n"),
  ).toThrow();
  const { record } = registryEvidence();
  Reflect.deleteProperty(record, "publicationAdmissionContract");
  Reflect.deleteProperty(record, "publicationAdmission");
  expect(validateAdmission(record)).toBeUndefined();
  expect(() => validateAdmission(record, { publicationAdmissionContract: "1" })).toThrow(
    /contract/u,
  );
});

function rejectReceipt(evidence: ReturnType<typeof registryEvidence>) {
  const { source, observations, descriptor, record } = evidence;
  refreshSource(evidence);
  const { binding } = record.publicationAdmission;
  binding.sourceDigest = source.digest;
  binding.observationsDigest = "sha256:" + digest(publicationObservationJson(observations));
  const error = /publication|bootstrap|prepared|authority/u;
  expect(() => createAdmission(source, observations, descriptor, binding.admittedAt)).toThrow(
    error,
  );
  expect(() => validateAdmission(record)).toThrow(error);
}

it("rejects pending npm authority for an existing root package", () => {
  const evidence = registryEvidence();
  evidence.observations.pendingAuthority = [
    {
      registry: "npm",
      name: "openclaw",
      action: "owner-preparation-and-access",
      status: "unresolved",
    },
  ];
  rejectReceipt(evidence);
});

// Prepared publisher identity belongs to clawhub-postpublish.test.ts; admission
// exercises that boundary in full-release-publication-admission.test.ts.
it.each([false, true])("rejects inverted ClawHub owner action (published=%s)", (published) => {
  const evidence = registryEvidence();
  const { source, observations } = evidence;
  assert(source.projection);
  source.projection.packages.unshift({ ...pluginPackage, targets: ["clawhub"] });
  observations.clawhub = [
    {
      ...pluginPackage,
      observedAt: observations.collectionStartedAt,
      state: {
        packageExists: true,
        alreadyPublished: published,
        hasTrustedPublisher: false,
        trustedPublisher: null,
      },
    },
  ];
  observations.plans.clawhub = {
    ...registryPlan(),
    all: [{ ...pluginPackage, alreadyPublished: published }],
    skippedPublished: published ? [pluginPackage.name] : [],
    bootstrapCandidates: [],
    missingTrustedPublisher: [pluginPackage.name],
  };
  observations.pendingAuthority = [
    {
      registry: "clawhub",
      name: pluginPackage.name,
      status: "unresolved",
      action: published ? "publisher-repair" : "configure-only",
    },
  ];
  rejectReceipt(evidence);
});

it("retains distinct root publication history in the actual reused manifest writer and budget", () => {
  const { plan, context } = registryBudgetFixture();
  const root = registryEvidence("99", 0, {}, "2026-09-13T13:00:00.000Z");
  const sourceManifest = { ...root.record, controls: {}, childEvidence: {} };
  const originalRoot = JSON.stringify(sourceManifest);
  const carried = {
    ...plan,
    evidenceReuse: {
      ...plan.evidenceReuse,
      requested: true,
      rootRunId: "99",
      selectedRunId: "99",
      evidenceSha: root.source.candidateSha,
      sourceManifest,
    },
  };
  const manifest = JSON.parse(manifestWriterFixture(carried).run(writerContext(context)));
  expect.soft(manifest.evidenceReuse.publication).toEqual(root.record);
  expect(manifest.publicationAdmission).toEqual(plan.publicationAdmission);
  expect(validateSource(manifest, { sourceAdmissionContract: "1" })).toEqual(plan.sourceAdmission);
  expect(manifest.sourceAdmission).not.toEqual(root.source);
  expect(JSON.stringify(sourceManifest)).toBe(originalRoot);
  expect(() => assertBudget(carried, context)).not.toThrow();
});

it("reserves escaped bounded fields and preserves job evidence at the UTF-8 byte limit", () => {
  const { plan, context } = registryBudgetFixture();
  expect(() => assertBudget(plan, context)).not.toThrow();
  // These are actual carried bytes, not assumed headroom for unknown future jobs.
  const root = {
    ...registryEvidence("99").record,
    retainedDiagnostic: "\0".repeat(65_000),
  };
  const carried = { ...plan, evidenceReuse: { ...plan.evidenceReuse, sourceManifest: root } };
  expect(() => serializeArtifact(carried)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify(root))).toBeGreaterThan(
    root.retainedDiagnostic.length * 5,
  );
  expect(() => assertBudget(carried, context)).toThrow(/size limit/u);

  const drain = fullMatrixDecision();
  const manifestContext = { ...context, validationInputs: { padding: "" } };
  const manifest = buildManifest({ plan, drain, context: manifestContext });
  manifestContext.validationInputs.padding = "x".repeat(
    MAX_RELEASE_ARTIFACT_BYTES - artifactSize(manifest),
  );
  const exact = buildManifest({ plan, drain, context: manifestContext });
  expect(artifactSize(exact)).toBe(MAX_RELEASE_ARTIFACT_BYTES);
  expect(exact.childEvidence).toEqual(manifest.childEvidence);
  manifestContext.validationInputs.padding += "é";
  expect(() => buildManifest({ plan, drain, context: manifestContext })).toThrow(/size limit/u);
});

it.each([false, true])(
  "budgets the actual reuse handoff before selected edges (combined oversize=%s)",
  (oversize) => {
    const { record, source, candidateRequest, context } = registryBudgetFixture(oversize ? 140 : 0);
    const root = registryEvidence("99", oversize ? 140 : 0).record;
    expect(() => serializeArtifact(record)).not.toThrow();
    expect(() => serializeArtifact(root)).not.toThrow();
    const directory = directories.make("publication-reuse-budget-");
    mkdirSync(join(directory, "full-release-publication-admission"));
    writeFileSync(
      join(directory, "full-release-publication-admission/publication-admission.json"),
      serializeArtifact(record),
    );
    const reuseOutputs = {
      reuse: "true",
      evidence_run_id: "99",
      evidence_root_run_id: "99",
      evidence_run_url: "https://github.com/openclaw/openclaw/actions/runs/99",
      evidence_sha: source.candidateSha,
      evidence_policy: "exact-target-full-validation-v1",
      changed_paths: "[]",
      changed_path_count: "0",
      evidence_manifest: JSON.stringify(root),
    };
    const retained = Object.entries(reuseOutputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");
    writeFileSync(join(directory, "reusable-evidence.outputs"), retained);
    const output = join(directory, "outputs");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/full-release-validation-state.mjs"), "reuse-publication"],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: output,
          ...githubContext(context),
          GITHUB_REPOSITORY: "openclaw/openclaw",
          CANDIDATE_REQUEST_JSON: JSON.stringify(candidateRequest),
        },
      },
    );
    expect(readFileSync(join(directory, "reusable-evidence.outputs"), "utf8")).toBe(retained);
    if (oversize) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("size limit");
      expect(existsSync(output)).toBe(false);
      const workflow = releaseWorkflow();
      for (const id of [
        "normal_ci",
        "prepare_npm_package",
        "prepare_docker_release",
        "candidate_acquisition",
        "performance",
        "plugin_prerelease_independent",
        "plugin_prerelease_candidate",
        "release_checks_independent",
        "release_checks_candidate",
        "npm_telegram",
      ]) {
        const job = workflow.jobs[id];
        expect(job.needs, id).toContain("evidence_reuse");
        expect(
          runInNewContext(job.if.replace(/^\s*\$\{\{|\}\}\s*$/gu, "").trim(), {
            always: () => true,
            fromJSON: JSON.parse,
            contains: (values: unknown[], value: unknown) => values.includes(value),
            inputs: { rerun_group: "all" },
            github: { run_attempt: 1 },
            needs: {
              resolve_target: { result: "success" },
              plugin_compatibility_readiness: { result: "success" },
              evidence_reuse: { result: "failure" },
            },
          }),
          id,
        ).toBe(false);
      }
    } else {
      expect(result.status, result.stderr).toBe(0);
      const forwarded = readFileSync(output, "utf8");
      expect(forwarded).toContain("reuse=true\n");
      expect(forwarded).not.toContain("evidence_manifest=");
      expect(forwarded).not.toContain("publicationAdmission");
      expect(Buffer.byteLength(forwarded, "utf16le")).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
    }
  },
);

function fullMatrixChildren() {
  return ["normalCi"].map((key) => {
    const runId = "1000";
    const composite = composeReleaseAttemptJobs(
      [
        {
          runAttempt: 1,
          jobs: Array.from({ length: 512 }, (_, index) => ({
            name: `Synthetic matrix job ${index}: ${"x".repeat(128)}`,
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-29T03:25:00Z",
            completed_at: "2026-08-29T03:26:00Z",
            html_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}/job/${index + 1}`,
          })),
        },
      ],
      { plannedRunAttempt: 1, effectiveRunAttempt: 1 },
    );
    return releaseChild(key, {
      runId,
      plannedRunAttempt: 1,
      compositeJobsSha256: composite.sha256,
      jobs: composite.jobs,
      observedRunAttempts: [1],
      status: "completed",
      conclusion: "success",
      dispatchActor: "github-actions[bot]",
      triggeringActor: "github-actions[bot]",
      repository: "openclaw/openclaw",
      workflow: `${key}.yml`,
      workflowRef: "main",
      url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
      createdAt: "2026-08-29T03:25:00Z",
      updatedAt: "2026-08-29T03:26:00Z",
    });
  });
}

function fullMatrixDecision(children = fullMatrixChildren()) {
  return buildReleaseStateArtifact({
    children,
    decision: { activeRunIds: [], blockers: [], errors: [], state: "passed" },
    executionPlan: { parentRunAttempt: 1, sha256: "b".repeat(64) },
    expected: {
      parentRunAttempt: 1,
      parentRunId: "123",
      workflowRef: "main",
      workflowSha: SHA,
      targetSha: SHA,
    },
    mode: "decision",
    releaseProfile: "full",
    rerunGroup: "all",
  });
}

function readDecision(reader: string, bytes: string) {
  const download = (args: string[]) => {
    writeFileSync(join(args[args.indexOf("--dir") + 1]!, "full-release-decision.json"), bytes);
  };
  return reader === "dispatch helper"
    ? tryReadReleaseDecision("123", 1, SHA, (_command, args) => {
        download(args);
        return { error: undefined, signal: null, status: 0, stderr: "", stdout: "" };
      })
    : tryReadReleaseDecisionArtifact(
        { attempt: 1, headSha: SHA },
        "123",
        "openclaw/openclaw",
        (args) => {
          download(args);
          return "";
        },
      );
}

function runDispatchWitness(event: unknown, rawEvent?: string) {
  const workflow = releaseWorkflow();
  const steps = workflow.jobs.resolve_target.steps;
  const writer = steps.find((step: { id?: string }) => step.id === "dispatch_witness");
  const dir = directories.make("full-release-dispatch-inputs-");
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, rawEvent ?? JSON.stringify(event));
  const context = {
    serverUrl: "https://github.com",
    repository: "openclaw/openclaw",
    workflowRef:
      "openclaw/openclaw/.github/workflows/full-release-validation.yml@refs/heads/release-ci/test",
    event: "workflow_dispatch",
    ref: "refs/heads/release-ci/test",
    sha: SHA,
    runId: "123",
    runAttempt: "2",
  };
  const result = spawnSync("bash", ["-c", writer.run], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: dir,
      GITHUB_EVENT_PATH: eventPath,
      DISPATCH_SERVER_URL: context.serverUrl,
      DISPATCH_WORKFLOW_REF: context.workflowRef,
      GITHUB_REPOSITORY: context.repository,
      GITHUB_EVENT_NAME: context.event,
      GITHUB_REF: context.ref,
      GITHUB_SHA: context.sha,
      GITHUB_RUN_ID: context.runId,
      GITHUB_RUN_ATTEMPT: context.runAttempt,
    },
  });
  const artifactPath = join(dir, "full-release-dispatch-inputs/dispatch-inputs.json");
  const bytes = existsSync(artifactPath) ? readFileSync(artifactPath, "utf8") : "";
  return { result, bytes, context, dir, workflow, writer, steps };
}

it("writes only a full-input digest and safe context", () => {
  const privateValue = "/private/example/operator/candidate.tgz";
  const secretValue = "synthetic-private-dispatch-value";
  const shellValue = 'line one\n$(touch unexpected) "quoted"';
  const { result, bytes, context, dir, writer, steps } = runDispatchWitness({
    inputs: {
      text: shellValue,
      secret: secretValue,
      package: privateValue,
      run_release_soak: "true",
      count: 3,
      empty: "",
    },
  });
  const canonical = JSON.stringify({
    count: "3",
    empty: "",
    package: privateValue,
    run_release_soak: "true",
    secret: secretValue,
    text: shellValue,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(bytes)).toEqual({
    kind: "openclaw.full-release-dispatch-inputs/v1",
    ...context,
    inputsDigest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
  });
  for (const value of [privateValue, secretValue, shellValue]) {
    expect(bytes + result.stdout + result.stderr + JSON.stringify(writer.env)).not.toContain(value);
  }
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
  expect(JSON.stringify(writer.env)).not.toMatch(/inputs|github\.event/u);
  expect(writer.run).not.toContain("${{");
  expect(existsSync(join(dir, "unexpected"))).toBe(false);
  expect(steps.indexOf(writer)).toBeLessThan(
    steps.findIndex((step: { id?: string }) => step.id === "tooling_identity"),
  );
});

it("binds primitive input values independently of event key order", () => {
  const inputs = { text: "value", count: 3, enabled: false };
  const original = runDispatchWitness({ inputs });
  const reordered = runDispatchWitness({ inputs: { enabled: "false", count: "3", text: "value" } });
  for (const { result } of [original, reordered]) {
    expect(result.status, result.stderr).toBe(0);
  }
  expect(reordered.bytes).toBe(original.bytes);
  const changed = runDispatchWitness({ inputs: { ...inputs, text: "changed" } });
  expect(changed.result.status, changed.result.stderr).toBe(0);
  expect(JSON.parse(changed.bytes).inputsDigest).not.toBe(JSON.parse(original.bytes).inputsDigest);
  expect(runDispatchWitness({ inputs: { value: "" } }).bytes).not.toBe(
    runDispatchWitness({ inputs: {} }).bytes,
  );
});

it.each([
  [
    "oversized event",
    { inputs: {}, padding: "x".repeat(1024 * 1024) },
    "Invalid or oversized root dispatch event",
  ],
  [
    "oversized inputs",
    { inputs: { payload: "x".repeat(129 * 1024) } },
    "Root dispatch inputs exceed their byte limit",
  ],
  [
    "nested inputs",
    { inputs: { payload: { private: "synthetic-private-dispatch-value" } } },
    "Invalid root dispatch inputs",
  ],
  [
    "malformed event",
    {},
    "Invalid or oversized root dispatch event",
    '{"inputs":"synthetic-private-dispatch-value',
  ],
] satisfies Array<[string, unknown, string, string?]>)(
  "refuses %s without a partial artifact or raw values in logs",
  (_name, event, error, rawEvent?: string) => {
    const { result, bytes } = runDispatchWitness(event, rawEvent);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.stderr + result.stdout).not.toContain("synthetic-private-dispatch-value");
    expect(bytes).toBe("");
  },
);

it.each([false, true])("writes complete large-matrix evidence with reuse=%s", (reuse) => {
  const children = fullMatrixChildren();
  const { plan, context } = registryBudgetFixture();
  const sourceManifest = {
    releaseProfile: "stable",
    runReleaseSoak: "true",
    childRuns: { normalCi: "1000" },
    validationInputs: { provider: "openai" },
    controls: { stableSoakRequired: true },
  };
  const carried = {
    ...plan,
    sourceAdmissionContract: undefined,
    sourceAdmission: undefined,
    publicationAdmissionContract: undefined,
    publicationAdmission: undefined,
    evidenceReuse: {
      ...plan.evidenceReuse,
      requested: reuse,
      selectedRunId: "99",
      rootRunId: "98",
      evidenceSha: "c".repeat(40),
      policy: "changelog-only-release-v1",
      changedPaths: ["CHANGELOG.md"],
      sourceManifest,
    },
  };
  const bytes = manifestWriterFixture(carried, fullMatrixDecision(children)).run(
    writerContext(context),
  );
  expect(Buffer.byteLength(bytes)).toBeGreaterThan(128 * 1024);
  expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
  const manifest = JSON.parse(bytes);
  expect(manifest.childEvidence).toMatchObject(
    Object.fromEntries(children.map(({ key, runId, jobs }) => [key, { runId, jobs }])),
  );
  expect(manifest).toMatchObject({
    version: 4,
    runId: context.runId,
    runAttempt: context.runAttempt,
    targetSha: plan.targetSha,
    candidateBinding: plan.candidate,
    executionPlanSha256: plan.sha256,
    sourceParentRunAttempt: 1,
  });
  expect(manifest).not.toHaveProperty("sourceAdmission");
  if (reuse) {
    expect(manifest).toMatchObject({
      ...sourceManifest,
      evidenceReuse: {
        policy: carried.evidenceReuse.policy,
        runId: "98",
        selectedRunId: "99",
        evidenceSha: carried.evidenceReuse.evidenceSha,
        changedPaths: ["CHANGELOG.md"],
      },
    });
  } else {
    expect(manifest).toMatchObject({ releaseProfile: "full", rerunGroup: "all" });
    expect(manifest).not.toHaveProperty("evidenceReuse");
  }
});

it.each(["ci.yml", "plugin-prerelease.yml"])(
  "keeps skipped matrix job names distinct in %s without renaming expanded checks",
  (file) => {
    const workflow = parse(readFileSync(`.github/workflows/${file}`, "utf8"));
    const shards = Object.entries(workflow.jobs).filter(([, raw]) =>
      String((raw as { name?: string }).name).includes("matrix.check_name"),
    );
    expect(shards.length).toBeGreaterThan(1);
    for (const [id, raw] of shards) {
      expect((raw as { name: string }).name).toBe(`\${{ matrix.check_name || '${id}' }}`);
    }
  },
);

it.each([
  ["dispatch helper", false],
  ["summary watcher", false],
  ["dispatch helper", true],
  ["summary watcher", true],
] as const)("%s reads complete evidence or rejects oversize=%s", (reader, oversized) => {
  if (oversized) {
    expect(() => readDecision(reader, " ".repeat(MAX_RELEASE_ARTIFACT_BYTES + 1))).toThrow(
      "size limit",
    );
  } else {
    const payload = fullMatrixDecision();
    const serialized = JSON.stringify(payload, null, 2);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
    expect(readDecision(reader, serialized)).toEqual(payload);
  }
});
