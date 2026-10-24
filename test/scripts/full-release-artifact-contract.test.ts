import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { isRecord } from "@openclaw/normalization-core";
import JSZip from "jszip";
import { afterEach, assert, expect, it } from "vitest";
import { parse } from "yaml";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
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
import { describeNpmBundle } from "../../scripts/npm-prepared-bundle.mjs";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";
import { tryReadReleaseDecisionArtifact } from "../../scripts/release-ci-summary.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
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
const absentNpmState = () => ({
  packageExists: false,
  hasVersionHistory: false,
  selectedVersionExists: false,
  latestVersion: null,
});
const pendingNpmAuthority = (
  name: string,
): ReturnType<typeof registryEvidence>["observations"]["pendingAuthority"] => [
  {
    registry: "npm",
    name,
    action: "owner-preparation-and-access",
    status: "unresolved",
  },
];

function expectPublication(
  manifest: Record<string, unknown>,
  targetSha: string,
  workflowSha: string,
) {
  expect(manifest).toMatchObject({
    publicationArtifacts: {
      npmPreflight: {
        source: { sha: targetSha },
        producer: { workflowSha, runId: "81", runAttempt: "1" },
      },
    },
    publishInputs: {
      targetSha,
      pluginSdkApiAcknowledgement: "",
      npmDecisions: [{ packageName: "openclaw", packageVersion: "2026.9.9", decision: "plan" }],
    },
  });
}

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

async function publicationWriterFixture(
  directory: string,
  identity: { sourceSha: string; workflowSha: string; workflowFullRef: string },
) {
  const hash = digest;
  const repository = "openclaw/openclaw";
  const workflow = ".github/workflows/full-release-artifacts.yml";
  const producer = {
    repository,
    workflowRef: `${repository}/${workflow}@${identity.workflowFullRef}`,
    workflowSha: identity.workflowSha,
    runId: "81",
    runAttempt: "1",
    jobId: "901",
    jobName: "Qualify prepared npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const diff = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const tarball = Buffer.from("synthetic prepared package bytes");
  async function bundle(
    file: string,
    manifest: { tarballName: string },
    id: string,
    name: string,
    qualified = false,
  ) {
    const bytes = JSON.stringify(manifest);
    writeFileSync(join(directory, file), bytes);
    const zip = new JSZip();
    zip.file(file, bytes);
    zip.file(manifest.tarballName, tarball);
    const archive = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
      platform: "UNIX",
    });
    const descriptor = describeNpmBundle({
      directory,
      qualified,
      artifact: {
        id,
        name,
        digest: hash(archive),
        runId: producer.runId,
        runAttempt: producer.runAttempt,
      },
    });
    return { archive, descriptor };
  }
  const preparedProducer = {
    ...producer,
    jobId: "900",
    jobName: "Prepare publishable npm package",
  };
  const packageManifest = {
    schema: "openclaw.npm-package-bundle/v1",
    producer: preparedProducer,
    releaseTag: "v2026.9.9",
    releaseSha: identity.sourceSha,
    npmDistTag: "latest",
    packageName: "openclaw",
    packageVersion: "2026.9.9",
    tarballName: "openclaw.tgz",
    tarballSha256: hash(tarball),
    corePackageTarballs: [],
  };
  const { descriptor: preparedBundle } = await bundle(
    "package-bundle.json",
    packageManifest,
    "554",
    "openclaw-npm-package-81-1",
  );
  const npmManifest = {
    version: 3,
    releaseSha: identity.sourceSha,
    tarballName: "openclaw.tgz",
    tarballSha256: hash(tarball),
    producer,
    preparedBundle,
    pluginSdkApi: createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.9.8",
      baseSha: "c".repeat(40),
      headSha: identity.sourceSha,
      workflowSha: identity.workflowSha,
      diff: { ...diff, digest: hash(JSON.stringify(diff)) },
    }),
  };
  const { archive, descriptor: qualified } = await bundle(
    "preflight-manifest.json",
    npmManifest,
    "555",
    `openclaw-npm-preflight-${identity.sourceSha}`,
    true,
  );
  const archivePath = join(directory, "qualified-npm.zip");
  writeFileSync(archivePath, archive);
  const api = `repos/${repository}/actions`;
  const preload = join(directory, "publication-transport.mjs");
  writeFileSync(
    preload,
    `
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const fixture = ${JSON.stringify({ ...identity, producer, artifact: qualified.artifact, archiveSize: archive.length, workflow, repository, api })};
const run = {
  id: 81, run_attempt: 1, head_sha: fixture.workflowSha, path: fixture.workflow,
  head_branch: fixture.workflowFullRef.replace("refs/heads/", ""), event: "workflow_dispatch",
  status: "completed", conclusion: "success",
  repository: { full_name: fixture.repository }, head_repository: { full_name: fixture.repository },
};
const artifact = {
  id: 555, name: fixture.artifact.name, digest: "sha256:" + fixture.artifact.digest,
  size_in_bytes: fixture.archiveSize, expired: false, expires_at: "2099-01-01T00:00:00Z",
  workflow_run: { id: 81, head_sha: fixture.workflowSha },
};
const responses = {
  [fixture.api + "/runs/81"]: run,
  [fixture.api + "/runs/81/attempts/1"]: run,
  [fixture.api + "/runs/81/attempts/1/jobs?per_page=100&page=1"]: { total_count: 1, jobs: [{
    id: 901, name: fixture.producer.jobName, run_id: 81, run_attempt: 1,
    head_sha: fixture.workflowSha, status: "completed", conclusion: "success",
  }] },
  [fixture.api + "/artifacts/555"]: artifact,
};
childProcess.execFileSync = (command, args) => {
  if (command !== "gh" || args[0] !== "api" || !Object.hasOwn(responses, args[1])) {
    throw new Error("Unexpected publication fixture subprocess");
  }
  for (let index = 2; index < args.length; index += 2) {
    if ((args[index] !== "--method" || args[index + 1] !== "GET") &&
        (args[index] !== "--jq" || typeof args[index + 1] !== "string")) {
      throw new Error("Unexpected publication fixture GitHub operation");
    }
  }
  return JSON.stringify(responses[args[1]]);
};
syncBuiltinESMExports();
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === "https://registry.npmjs.org/openclaw") {
    return Response.json({ versions: { "2026.9.8": {} }, "dist-tags": { latest: "2026.9.8", beta: "2026.9.8" } });
  }
  if (url.origin !== "https://api.github.com" || new Headers(options?.headers).get("authorization") !== "Bearer artifact-fixture-token") {
    throw new Error("Unexpected publication fixture transport");
  }
  const endpoint = url.pathname.slice(1) + url.search;
  if (endpoint === ${JSON.stringify(`${api}/artifacts/555/zip`)}) return new Response(readFileSync(${JSON.stringify(archivePath)}));
  if (Object.hasOwn(responses, endpoint)) return Response.json(responses[endpoint]);
  throw new Error("Unexpected publication fixture endpoint");
};
`,
  );
  return {
    GH_TOKEN: "artifact-fixture-token",
    GITHUB_TOKEN: "",
    NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    PREPARED_PLUGIN_NPM_JSON: JSON.stringify({ descriptor: "prepared-plugin-npm" }),
    QUALIFIED_NPM_BUNDLE_JSON: JSON.stringify(qualified),
  };
}

function registryEvidence(
  runId = "123",
  warningCount = 0,
  validationInputs: Record<string, string> = {},
  started = "2026-09-13T14:00:00.000Z",
) {
  const source = createSource(
    sourceRequest(validationInputs, { GITHUB_RUN_ID: runId }),
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

function registryBudgetFixture(warningCount = 0, validationInputs: Record<string, string> = {}) {
  const { record, source } = registryEvidence("123", warningCount, validationInputs);
  const releaseProfile = source.coverage.release_profile;
  const runReleaseSoak = source.coverage.run_release_soak;
  const candidateRequest = buildFullReleaseCandidateRequest({
    repository: source.repository,
    targetSha: source.candidateSha,
    toolingSha: source.workflow.sha,
    releaseProfile,
    releaseSoak: runReleaseSoak === "true",
    upgradeSurvivorBaseline: "openclaw@latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "reported-issues",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: source.coverage.allow_unreleased_changelog === "true",
    packagePublished: false,
    sharedImagePolicy: "no-push-artifact",
  });
  const inputs = {
    childPhaseVersion: 3,
    parentRunId: "123",
    parentRunAttempt: 1,
    workflowRef: "release-ci/test",
    workflowSha: SHA,
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
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
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
    workflowSha: SHA,
    targetRef: source.candidateSha,
    releaseProfile,
    rerunGroup: "all",
    runReleaseSoak,
    validationInputs: {},
  };
  return { record, source, plan, context, candidateRequest };
}

it.each(["beta", "stable", "full"])(
  "writes fresh %s performance and Telegram evidence through the actual workflow command",
  async (releaseProfile) => {
    const telegram = {
      npm_telegram_package_spec: "openclaw@2026.9.9",
      npm_telegram_provider_mode: "live-frontier",
      npm_telegram_scenario: "telegram-status-command",
      skip_package_telegram_e2e: "true",
      allow_unreleased_changelog: "true",
    };
    const { plan, context } = registryBudgetFixture(0, {
      ...telegram,
      release_profile: releaseProfile,
    });
    expect(plan.evidenceReuse.requested).toBe(false);
    const { writer, directory, run } = manifestWriterFixture(plan);
    const inputs = {
      ...telegram,
      release_profile: releaseProfile,
      ref: context.targetRef,
      rerun_group: context.rerunGroup,
      run_release_soak: false,
    };
    const expressionContext = {
      inputs,
      needs: { resolve_target: { outputs: { skip_package_telegram_e2e: "true" } } },
    };
    const selectedEnv = Object.fromEntries(
      [
        "RELEASE_PROFILE",
        "NPM_TELEGRAM_PACKAGE_SPEC",
        "NPM_TELEGRAM_PROVIDER_MODE",
        "NPM_TELEGRAM_SCENARIO",
        "SKIP_PACKAGE_TELEGRAM_E2E",
        "ALLOW_UNRELEASED_CHANGELOG",
      ].map((key) => [
        key,
        String(
          runInNewContext(writer.env[key].replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), expressionContext),
        ),
      ]),
    );
    const manifest = JSON.parse(
      run({
        ...writerContext(context),
        ...selectedEnv,
        ...(await publicationWriterFixture(directory, {
          sourceSha: context.targetRef,
          workflowSha: context.workflowSha,
          workflowFullRef: context.workflowFullRef,
        })),
      }),
    );
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
    expectPublication(manifest, context.targetRef, context.workflowSha);
  },
);

it("separates immutable observation bytes from post-upload admission and ZIP digest", () => {
  const { observations, admission, record } = registryEvidence();
  expect(observations).not.toHaveProperty("admittedAt");
  expect(observations).not.toHaveProperty("artifact");
  expect(observations).not.toHaveProperty("status");
  expect(admission.binding.observationsDigest).toBe(
    `sha256:${createHash("sha256").update(publicationObservationJson(observations)).digest("hex")}`,
  );
  expect(admission.binding.observationsDigest).not.toBe(admission.binding.artifact.digest);
  expect(validateAdmission(record)).toEqual(admission);
});

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

it.each([
  ["openclaw", true],
  ["@openclaw/gateway-client", true],
  ["openclaw", false],
] as const)("rejects pending npm authority for %s (absent=%s)", (name, absent) => {
  const evidence = registryEvidence();
  const { source, observations } = evidence;
  assert(source.projection);
  const root = observations.npm[0]!;
  assert(root.outcome === "observed");
  source.projection.packages = [{ name, version: "2026.9.9", targets: ["npm"] }];
  root.name = name;
  if (absent) {
    root.state = absentNpmState();
  }
  observations.pendingAuthority = pendingNpmAuthority(name);
  rejectReceipt(evidence);
});

it.each([
  "prepared-package-absent",
  "prepared-wrong-provider",
  "prepared-wrong-repository",
  "prepared-wrong-workflow",
  "prepared-environment",
  "prepared-missing-normal-trust",
  "configure-as-repair",
  "repair-as-configure",
])("rejects unsupported ClawHub receipt semantics: %s", (fault) => {
  const evidence = registryEvidence();
  const { source, observations } = evidence;
  assert(source.projection && source.publicationSelection);
  source.projection.packages.unshift({ ...pluginPackage, targets: ["clawhub"] });
  if (fault.startsWith("prepared-")) {
    source.publicationSelection.route = "prepared";
  }
  const present = fault !== "prepared-package-absent";
  const published = fault === "configure-as-repair";
  const trusted =
    fault.startsWith("prepared-") && present && fault !== "prepared-missing-normal-trust";
  const publisher =
    trusted || fault === "prepared-missing-normal-trust"
      ? {
          provider: fault === "prepared-wrong-provider" ? "other" : "github-actions",
          repository: fault === "prepared-wrong-repository" ? "other/repo" : "openclaw/openclaw",
          workflowFilename:
            fault === "prepared-wrong-workflow" ? "other.yml" : "plugin-clawhub-release.yml",
          environment: fault === "prepared-environment" ? "other" : null,
        }
      : null;
  observations.clawhub = [
    {
      ...pluginPackage,
      observedAt: observations.collectionStartedAt,
      state: {
        packageExists: present,
        alreadyPublished: published,
        hasTrustedPublisher: trusted,
        trustedPublisher: publisher,
      },
    },
  ];
  observations.plans.clawhub = {
    ...registryPlan(),
    all: [{ ...pluginPackage, alreadyPublished: published }],
    candidates: present && trusted && !published ? ["@openclaw/test"] : [],
    skippedPublished: published ? ["@openclaw/test"] : [],
    bootstrapCandidates: present ? [] : ["@openclaw/test"],
    missingTrustedPublisher: present && !trusted ? ["@openclaw/test"] : [],
  };
  observations.pendingAuthority = trusted
    ? []
    : [
        {
          registry: "clawhub",
          name: "@openclaw/test",
          status: "unresolved",
          action: !present
            ? "bootstrap-and-owner-access"
            : published
              ? "publisher-repair"
              : "configure-only",
        },
      ];
  rejectReceipt(evidence);
});

it.each([
  ["normal", "beta", "2026.9.9-beta.1", true],
  ["prepared", "beta", "2026.9.9-beta.1", true],
  ["normal", "latest", "2026.9.9-beta.1", true],
  ["prepared", "latest", "2026.9.9-beta.1", true],
  ["normal", "latest", "2026.9.9", true],
  ["prepared", "latest", "2026.9.9-1", true],
  ["normal", "beta", "2026.9.9", false],
  ["prepared", "beta", "2026.9.9-1", false],
  ["extended-stable", "extended-stable", "2026.8.33", false],
] as const)(
  "retains only supported plugin absence on %s/%s/%s (accepted=%s)",
  (route, npmDistTag, version, accepted) => {
    const evidence = registryEvidence();
    const { source, observations, descriptor, admission } = evidence;
    assert(source.publicationSelection && source.projection);
    Object.assign(source.publicationSelection, { route, npmDistTag });
    const rootVersion = route === "extended-stable" ? version : "2026.9.9";
    source.projection.version = rootVersion;
    source.projection.packages = [
      { name: "@openclaw/test", version, targets: ["npm"] },
      { name: "openclaw", version: rootVersion, targets: ["npm"] },
    ];
    refreshSource(evidence);
    const root = observations.npm[0]!;
    assert(root.outcome === "observed");
    observations.npm = [
      {
        ...root,
        name: "@openclaw/test",
        version,
        state: absentNpmState(),
      },
      { ...root, version: rootVersion },
    ];
    observations.plans.npm = {
      ...registryPlan(),
      all: [{ name: "@openclaw/test", version, alreadyPublished: false }],
      candidates: ["@openclaw/test"],
    };
    observations.pendingAuthority = pendingNpmAuthority("@openclaw/test");
    const create = () =>
      createAdmission(source, observations, descriptor, admission.binding.admittedAt);
    if (accepted) {
      expect(create().observations.pendingAuthority).toEqual(observations.pendingAuthority);
    } else {
      expect(create).toThrow(/bootstrap/u);
    }
  },
);

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
  expect(JSON.stringify(sourceManifest)).toBe(originalRoot);
  expect(() => assertBudget(carried, context)).not.toThrow();
  const current = registryEvidence("123", 132);
  const largeRoot = registryEvidence("99", 132);
  const combined = {
    ...carried,
    ...current.record,
    evidenceReuse: {
      ...carried.evidenceReuse,
      sourceManifest: { ...sourceManifest, ...largeRoot.record },
    },
  };
  // Each receipt fits; the actual root/current enclosing writer must not drop
  // the older one to appear under the cap.
  expect(() => serializeArtifact(largeRoot.record)).not.toThrow();
  expect(() => serializeArtifact(current.record)).not.toThrow();
  expect(() => buildManifest({ plan: combined, context })).toThrow(/size limit/u);
  expect(() => assertBudget(combined, context)).toThrow(/size limit/u);
});

it("budgets compact retry plans with their revalidated root manifest", () => {
  const { plan, context } = registryBudgetFixture();
  const current = registryEvidence("123", 132);
  const root = registryEvidence("99", 132);
  const compact = {
    ...plan,
    ...current.record,
    evidenceReuse: {
      changedPaths: [],
      evidenceSha: root.source.candidateSha,
      policy: "exact-target-full-validation-v1",
      requested: true,
      rootRunId: "99",
      runUrl: "https://example.invalid/runs/99",
      selectedRunId: "99",
      sourceArtifact: {
        digest: "d".repeat(64),
        id: "901",
        name: "full-release-manifest-99-1",
        runAttempt: 1,
        sizeInBytes: 4096,
      },
      sourceWorkflow: { ref: "release-ci/test", sha: SHA },
    },
  };

  expect(() => serializeArtifact(compact)).not.toThrow();
  expect(() => assertBudget(compact, context, root.record)).toThrow(/size limit/u);
});

it("reserves JSON escaping of pending bounded fields without truncating later job evidence", () => {
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
  const manifest = buildManifest({ plan, drain, context });
  const firstChild = Object.values(drain.children)[0]!;
  assert(isRecord(firstChild.timing) && Array.isArray(firstChild.timing.jobs));
  const firstJob = firstChild.timing.jobs[0]!;
  assert(isRecord(firstJob) && typeof firstJob.url === "string");
  assert(isRecord(manifest.childEvidence) && isRecord(manifest.childEvidence.normalCi));
  assert(Array.isArray(manifest.childEvidence.normalCi.jobs));
  const projectedJob = manifest.childEvidence.normalCi.jobs[0];
  assert(isRecord(projectedJob));
  const remaining = MAX_RELEASE_ARTIFACT_BYTES - artifactSize(manifest);
  const extraJob = { ...firstJob, name: "later child job 000000" };
  const jobBytes =
    Buffer.byteLength(
      JSON.stringify({
        ...projectedJob,
        name: extraJob.name,
      }),
    ) + 1;
  const count = Math.floor(remaining / jobBytes);
  firstChild.timing.jobs.push(
    ...Array.from({ length: count }, (_, index) => ({
      ...extraJob,
      name: `later child job ${String(index).padStart(6, "0")}`,
    })),
  );
  const grownBytes = artifactSize(buildManifest({ plan, drain, context }));
  firstJob.url += "x".repeat(MAX_RELEASE_ARTIFACT_BYTES - grownBytes);
  expect(firstJob.url.length).toBeLessThanOrEqual(1024);
  expect(artifactSize(buildManifest({ plan, drain, context }))).toBe(MAX_RELEASE_ARTIFACT_BYTES);
  firstJob.url += "x";
  expect(() => buildManifest({ plan, drain, context })).toThrow(/size limit/u);
  expect(firstChild.timing.jobs).toHaveLength(186 + count);
  expect(plan.publicationAdmission).toEqual(registryEvidence().admission);
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
    const workflow = releaseWorkflow();
    const step = workflow.jobs.evidence_reuse.steps.find(
      (value: { id?: string }) => value.id === "find",
    );
    const command = step.run.trim().split("\n").at(-1);
    expect(command).toBe(
      "node workflow/scripts/full-release-validation-state.mjs reuse-publication",
    );
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
  // Observed full-profile fanout from parent 33230733150, including both phases.
  const counts = {
    normalCi: 186,
    pluginPrereleaseIndependent: 38,
    pluginPrereleaseCandidate: 44,
    releaseChecksIndependent: 130,
    releaseChecksCandidate: 121,
    productPerformance: 7,
  };
  return Object.entries(counts).map(([key, count], childIndex) => {
    const runId = String(1000 + childIndex);
    const composite = composeReleaseAttemptJobs(
      [
        {
          runAttempt: 1,
          jobs: Array.from({ length: count }, (_, index) => ({
            name: `${key} / Docker and repository validation shard ${index}`,
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
    return {
      key,
      runId,
      selected: true,
      runAttempt: 1,
      plannedRunAttempt: 1,
      compositeJobsSha256: composite.sha256,
      jobs: composite.jobs,
      observedRunAttempts: [1],
      status: "completed",
      conclusion: "success",
      dispatchActor: "github-actions[bot]",
      triggeringActor: "github-actions[bot]",
      displayTitle: key,
      repository: "openclaw/openclaw",
      errors: [],
      workflow: `${key}.yml`,
      workflowRef: "main",
      workflowSha: SHA,
      url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
      createdAt: "2026-08-29T03:25:00Z",
      updatedAt: "2026-08-29T03:26:00Z",
    };
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
  const { result, bytes, context, dir, workflow, writer, steps } = runDispatchWitness({
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
  expect(workflow.env.FULL_RELEASE_DISPATCH_WITNESS_CONTRACT).toBe("1");
  expect(steps.indexOf(writer)).toBeLessThan(
    steps.findIndex((step: { id?: string }) => step.id === "tooling_identity"),
  );
  expect(
    steps.find((step: { name?: string }) => step.name === "Upload root dispatch inputs").with,
  ).toMatchObject({
    name: "full-release-dispatch-inputs-${{ github.run_id }}-${{ github.run_attempt }}",
    "if-no-files-found": "error",
    "retention-days": 7,
  });
});

it("binds every declared input and default independently of event key order", () => {
  const workflow = releaseWorkflow();
  const definitions = workflow.on.workflow_dispatch.inputs as Record<string, { default?: unknown }>;
  const inputs = Object.fromEntries(
    Object.entries(definitions).map(([key, definition]) => {
      const value = definition.default ?? "";
      if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
        throw new Error("Workflow input default must be a primitive");
      }
      return [key, String(value)];
    }),
  );
  const original = runDispatchWitness({ inputs });
  expect(original.result.status, original.result.stderr).toBe(0);
  const reordered = runDispatchWitness({
    inputs: Object.fromEntries(Object.entries(inputs).toReversed()),
  });
  expect(reordered.result.status, reordered.result.stderr).toBe(0);
  expect(reordered.bytes).toBe(original.bytes);
  for (const key of Object.keys(inputs)) {
    const changed = runDispatchWitness({
      inputs: { ...inputs, [key]: `${inputs[key]}-changed` },
    });
    expect(changed.result.status, changed.result.stderr).toBe(0);
    expect(JSON.parse(changed.bytes).inputsDigest, key).not.toBe(
      JSON.parse(original.bytes).inputsDigest,
    );
  }
  expect(runDispatchWitness({ inputs: { value: false, count: 3 } }).bytes).toBe(
    runDispatchWitness({ inputs: { count: "3", value: "false" } }).bytes,
  );
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

it.each([
  { reuse: false, source: false },
  { reuse: true, source: false },
  { reuse: false, source: true },
  { reuse: true, source: true },
])(
  "writes all matrix evidence with reuse=$reuse source=$source without argv size limits",
  async ({ reuse, source }) => {
    const children = fullMatrixChildren();
    const drain = fullMatrixDecision(children);
    const expectedChildren = Object.fromEntries(
      children.map((child) => [
        child.key,
        {
          runId: child.runId,
          plannedRunAttempt: child.plannedRunAttempt,
          observedRunAttempts: child.observedRunAttempts,
          compositeJobsSha256: child.compositeJobsSha256,
          dispatchActor: child.dispatchActor,
          triggeringActor: child.triggeringActor,
          repository: child.repository,
          effectiveRunAttempt: child.runAttempt,
          jobs: child.jobs,
        },
      ]),
    );
    expect(Buffer.byteLength(JSON.stringify(expectedChildren))).toBeGreaterThan(128 * 1024);
    const request = sourceRequest(
      { provider: "openai" },
      {
        PUBLICATION_TOOLING_JSON: JSON.stringify({
          fullRef: "refs/heads/main",
          sha: "d".repeat(40),
        }),
        PUBLICATION_TARGET_SHA: SHA,
        GITHUB_SHA: "d".repeat(40),
        GITHUB_RUN_ID: "124",
      },
    );
    const projection = sourceProjection();
    const sourceAdmission = createSource(request, inventory, projection);
    const oldSource = createSource(
      {
        ...request,
        runId: "98",
        candidateSha: "c".repeat(40),
      },
      inventory,
      projection,
    );
    const trustedWorkflow = { fullRef: "refs/heads/main", ref: "main", sha: "d".repeat(40) };
    const sourceManifest = {
      workflowName: "Full Release Validation",
      ...(source
        ? { sourceAdmissionContract: "1", sourceAdmission: oldSource, trustedWorkflow }
        : {}),
      releaseProfile: source ? "full" : "stable",
      rerunGroup: "all",
      runReleaseSoak: "true",
      childRuns: { normalCi: "1000" },
      validationInputs: {
        provider: "openai",
        ...(source
          ? {
              ...publicationIntentInputs(oldSource),
              targetContextRef: "release/2026.9.9",
              allowUnreleasedChangelog: "false",
            }
          : {}),
      },
      controls: { stableSoakRequired: true },
      childEvidence: expectedChildren,
    };
    const plan = {
      ...(source ? { sourceAdmissionContract: "1", sourceAdmission, trustedWorkflow } : {}),
      targetSha: SHA,
      sha256: "b".repeat(64),
      parentRunAttempt: 1,
      candidate: { package: { sourceSha: SHA } },
      children: children.map((child) => ({
        key: child.key,
        runId: child.runId,
      })),
      evidenceReuse: {
        requested: reuse,
        selectedRunId: "99",
        rootRunId: "98",
        evidenceSha: "c".repeat(40),
        policy: "changelog-only-release-v1",
        changedPaths: ["CHANGELOG.md"],
        sourceManifest,
      },
    };
    const { directory: dir, run } = manifestWriterFixture(plan, drain);
    const bytes = run({
      EXTENSION_TEST_EXCLUDE_PATTERNS_JSON: "[]",
      GITHUB_RUN_ID: "124",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_REF_NAME: "release-ci/test",
      GITHUB_SHA: "d".repeat(40),
      GITHUB_REF: "refs/heads/release-ci/test",
      GITHUB_REF_TYPE: "branch",
      TARGET_REF: SHA,
      ...(source
        ? {
            TARGET_CONTEXT_REF: "release/2026.9.9",
            PROVIDER: "openai",
            ALLOW_UNRELEASED_CHANGELOG: "false",
          }
        : {}),
      RELEASE_PROFILE: "full",
      RERUN_GROUP: "all",
      RUN_RELEASE_SOAK: "true",
      ...(source
        ? await publicationWriterFixture(dir, {
            sourceSha: SHA,
            workflowSha: "d".repeat(40),
            workflowFullRef: "refs/heads/release-ci/test",
          })
        : {}),
    });
    expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
    const manifest = JSON.parse(bytes);
    if (source) {
      expectPublication(manifest, SHA, "d".repeat(40));
      expect(manifest.publicationArtifacts.pluginNpm).toEqual({
        descriptor: "prepared-plugin-npm",
      });
      expect(validateSource(manifest, { sourceAdmissionContract: "1" })).toEqual(sourceAdmission);
      expect(manifest.sourceAdmission).not.toEqual(oldSource);
      expect(sourceManifest.sourceAdmission).toEqual(oldSource);
      expect(manifest.validationInputs.publicationSelectionJson).toBe(
        publicationIntentInputs(sourceAdmission).publicationSelectionJson,
      );
    } else {
      expect(manifest).not.toHaveProperty("sourceAdmission");
    }
    expect(manifest.childEvidence).toEqual(expectedChildren);
    expect(manifest).toMatchObject({
      version: 4,
      runId: "124",
      runAttempt: "2",
      targetSha: SHA,
      candidateBinding: plan.candidate,
      executionPlanSha256: plan.sha256,
      sourceParentRunAttempt: 1,
    });
    if (reuse) {
      expect(manifest).toMatchObject({
        releaseProfile: source ? "full" : "stable",
        runReleaseSoak: "true",
        childRuns: sourceManifest.childRuns,
        validationInputs: sourceManifest.validationInputs,
        evidenceReuse: {
          policy: plan.evidenceReuse.policy,
          runId: "98",
          selectedRunId: "99",
          evidenceSha: plan.evidenceReuse.evidenceSha,
          changedPaths: ["CHANGELOG.md"],
        },
      });
    } else {
      expect(manifest).toMatchObject({
        releaseProfile: "full",
        rerunGroup: "all",
        childRuns: sourceManifest.childRuns,
      });
      expect(manifest).not.toHaveProperty("evidenceReuse");
    }
  },
);

it("compacts the full matrix without dropping job evidence and bounds UTF-8 bytes", () => {
  const payload = fullMatrixDecision();
  const compact = serializeArtifact(payload);
  expect(JSON.parse(compact)).toEqual(payload);
  expect(Buffer.byteLength(compact)).toBeGreaterThan(128 * 1024);
  expect(Buffer.byteLength(compact)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
  expect(compact.split("\n")).toHaveLength(2);

  const value = "x".repeat(MAX_RELEASE_ARTIFACT_BYTES - artifactSize({ value: "" }));
  expect(artifactSize({ value })).toBe(MAX_RELEASE_ARTIFACT_BYTES);
  expect(() => serializeArtifact({ value: `${value}é` })).toThrow("size limit");
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
