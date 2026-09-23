import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { isRecord } from "@openclaw/normalization-core";
import { afterEach, assert, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  createPublicationAdmission,
  createPublicationObservations,
  createPublicationSourceFact,
  publicationAdmissionContract,
  publicationDispatchEnvelope,
  publicationIntentInputs,
  publicationObservationJson,
  publicationSourceJson,
  publicationSourceRequest,
  validatePublicationAdmissionBinding,
  validatePublicationSourceBinding,
} from "../../scripts/full-release-publication-contract.mjs";
import { tryReadReleaseDecision } from "../../scripts/full-release-validation-at-sha.mts";
import {
  assertReleasePublicationKnownBudget,
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  buildReleaseStateArtifact,
  buildReleaseValidationManifest,
  composeReleaseAttemptJobs,
  MAX_RELEASE_ARTIFACT_BYTES,
  serializeReleaseArtifact,
} from "../../scripts/full-release-validation-policy.mjs";
import { tryReadReleaseDecisionArtifact } from "../../scripts/release-ci-summary.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SHA = "a".repeat(40);

function registryEvidence(
  runId = "123",
  warningCount = 0,
  validationInputs: Record<string, string> = {},
) {
  const source = createPublicationSourceFact(
    publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        ref: SHA,
        release_profile: "full",
        rerun_group: "all",
        ...validationInputs,
        trusted_workflow_json: publicationDispatchEnvelope(null, {
          validationPurpose: "publish",
          publicationSelection: {
            route: "normal",
            npmDistTag: "latest",
            publishOpenclawNpm: true,
            pluginPublishScope: "all-publishable",
            plugins: [],
          },
        }),
      }),
      PUBLICATION_TOOLING_JSON: JSON.stringify({ fullRef: "refs/heads/main", sha: SHA }),
      PUBLICATION_TARGET_CONTEXT: "release/2026.9.9",
      PUBLICATION_TARGET_SHA: "b".repeat(40),
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: "refs/heads/release-ci/test",
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: "1",
    }),
    { packages: [], platforms: [] },
    {
      version: "2026.9.9",
      packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
      platforms: [],
    },
  );
  const started = "2026-09-13T14:00:00.000Z";
  const observations = createPublicationObservations(source, {
    sourceDigest: source.digest,
    prerequisitesCompletedAt: started,
    collectionStartedAt: started,
    collectionCompletedAt: "2026-09-13T14:00:01.000Z",
    npm: [
      {
        name: "openclaw",
        version: "2026.9.9",
        required: true,
        observedAt: started,
        outcome: "observed",
        state: {
          packageExists: true,
          hasVersionHistory: true,
          selectedVersionExists: false,
          latestVersion: "2026.9.8",
        },
      },
    ],
    clawhub: [],
    pendingAuthority: [],
    plans: {
      npm: {
        all: [],
        candidates: [],
        skippedPublished: [],
        warnings: Array.from({ length: warningCount }, () => "w".repeat(4000)),
      },
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
  const descriptor = {
    id: "456",
    name: `full-release-publication-observations-${runId}-1`,
    digest: `sha256:${"c".repeat(64)}`,
    sizeInBytes: 2048,
  };
  const admission = createPublicationAdmission(
    source,
    observations,
    descriptor,
    "2026-09-13T14:00:02.000Z",
  );
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
  const plan = buildReleaseExecutionPlanArtifact({
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

describe("retained publication admission", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);

  it.each(["beta", "stable"])(
    "writes fresh %s performance and Telegram evidence through the actual workflow command",
    (releaseProfile) => {
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
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
      const writer = workflow.jobs.summary.steps.find(
        (step: { name: string }) => step.name === "Write release validation manifest",
      );
      const directory = directories.make("publication-fresh-manifest-");
      const planPath = join(directory, "plan.json");
      const drainPath = join(directory, "drain.json");
      writeFileSync(planPath, serializeReleaseArtifact(plan));
      writeFileSync(drainPath, serializeReleaseArtifact({ children: {} }));
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
            runInNewContext(
              writer.env[key].replace(/^\$\{\{\s*|\s*\}\}$/gu, ""),
              expressionContext,
            ),
          ),
        ]),
      );
      const result = spawnSync("bash", ["-c", writer.run], {
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.keys(writer.env).map((key) => [key, ""])),
          ...selectedEnv,
          PATH: process.env.PATH,
          RUNNER_TEMP: directory,
          GITHUB_RUN_ID: context.runId,
          GITHUB_RUN_ATTEMPT: context.runAttempt,
          GITHUB_REF_NAME: context.workflowRef,
          GITHUB_SHA: context.workflowSha,
          GITHUB_REF: context.workflowFullRef,
          GITHUB_REF_TYPE: context.workflowRefType,
          TARGET_REF: context.targetRef,
          RERUN_GROUP: context.rerunGroup,
          RUN_RELEASE_SOAK: context.runReleaseSoak,
          RELEASE_EXECUTION_PLAN_PATH: planPath,
          DIAGNOSTIC_DRAIN_PATH: drainPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(
        readFileSync(
          join(directory, "full-release-validation/full-release-validation-manifest.json"),
          "utf8",
        ),
      );
      expect(manifest.releaseProfile).toBe(releaseProfile);
      expect(manifest.controls).toMatchObject({
        performanceBlocking: releaseProfile !== "beta",
        performanceReportPublication: "artifact-only",
      });
      expect(manifest.childRuns.productPerformance.blocking).toBe(releaseProfile !== "beta");
      expect(manifest.validationInputs).toMatchObject({
        npmTelegramPackageSpec: "openclaw@2026.9.9",
        npmTelegramProviderMode: "live-frontier",
        npmTelegramScenario: "telegram-status-command",
        skipPackageTelegramE2e: "true",
        allowUnreleasedChangelog: "true",
      });
      expect(manifest.publicationAdmission).toEqual(plan.publicationAdmission);
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
    expect(validatePublicationAdmissionBinding(record)).toEqual(admission);
    // Validation years later does not substitute a new clock or registry sweep.
    expect(validatePublicationAdmissionBinding(structuredClone(record))).toEqual(admission);
  });

  it.each([
    ["2026-09-13T14:05:00.000Z", true],
    ["2026-09-13T14:05:00.001Z", false],
    ["2026-09-13T13:59:59.999Z", false],
  ])("checks actual post-upload admission time %s (accepted=%s)", (time, accepted) => {
    const { source, observations, descriptor } = registryEvidence();
    const finalize = () => createPublicationAdmission(source, observations, descriptor, time);
    if (accepted) {
      expect(finalize().binding.admittedAt).toBe(time);
    } else {
      expect(finalize).toThrow(/time|freshness/u);
    }
  });

  it.each([
    "missing-observation",
    "extra-required",
    "empty-history",
    "extra-state-field",
    "missing-state-field",
    "future-observation",
    "changed-content",
    "source",
    "artifact-attempt",
    "artifact-digest",
    "extra-binding-field",
    "missing-binding",
    "deleted-contract",
  ])("rejects incomplete or altered retained evidence: %s", (fault) => {
    const { record } = registryEvidence();
    const admission = record.publicationAdmission;
    const first = admission.observations.npm[0]!;
    if (fault === "missing-observation") {
      admission.observations.npm = [];
    }
    if (fault === "extra-required") {
      admission.observations.npm.push({ ...first, name: "unselected-package" });
    }
    if (fault === "empty-history" && first.outcome === "observed") {
      first.state.hasVersionHistory = false;
    }
    if (fault === "extra-state-field" && first.outcome === "observed") {
      Object.assign(first.state, { packageDir: "/private/synthetic/candidate" });
    }
    if (fault === "missing-state-field" && first.outcome === "observed") {
      Reflect.deleteProperty(first.state, "hasVersionHistory");
    }
    if (fault === "future-observation") {
      first.observedAt = "2026-09-13T14:00:03.000Z";
    }
    if (fault === "changed-content") {
      admission.observations.plans.npm.warnings.push("changed");
    }
    if (fault === "source") {
      admission.binding.sourceDigest = "d".repeat(64);
    }
    if (fault === "artifact-attempt") {
      admission.binding.artifact.name = "full-release-publication-observations-123-2";
    }
    if (fault === "artifact-digest") {
      admission.binding.artifact.digest = "c".repeat(64);
    }
    if (fault === "extra-binding-field") {
      Object.assign(admission.binding, { publicationAuthorized: true });
    }
    if (fault === "missing-binding") {
      Reflect.deleteProperty(admission, "binding");
    }
    if (fault === "deleted-contract") {
      Reflect.deleteProperty(record, "publicationAdmissionContract");
    }
    expect(() =>
      validatePublicationAdmissionBinding(record, { publicationAdmissionContract: "1" }),
    ).toThrow(/publication|observation|registry/u);
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
    expect(validatePublicationAdmissionBinding(record)).toBeUndefined();
    expect(() =>
      validatePublicationAdmissionBinding(record, { publicationAdmissionContract: "1" }),
    ).toThrow(/contract/u);
  });

  it.each([
    "root-absent",
    "core-companion-absent",
    "healthy-with-pending",
    "prepared-package-absent",
    "prepared-wrong-provider",
    "prepared-wrong-repository",
    "prepared-wrong-workflow",
    "prepared-environment",
    "prepared-missing-normal-trust",
    "configure-as-repair",
    "repair-as-configure",
  ])("rejects self-consistent unsupported receipt semantics: %s", (fault) => {
    const { source, observations, descriptor, record } = registryEvidence();
    const root = observations.npm[0]!;
    assert(root.outcome === "observed");
    if (fault === "core-companion-absent") {
      assert(source.projection);
      source.projection.packages = [
        { name: "@openclaw/gateway-client", version: "2026.9.9", targets: ["npm"] },
      ];
      const { digest: _digest, ...unsigned } = source;
      source.digest = createHash("sha256").update(publicationSourceJson(unsigned)).digest("hex");
      observations.sourceDigest = source.digest;
      root.name = "@openclaw/gateway-client";
    }
    if (fault === "root-absent" || fault === "core-companion-absent") {
      root.state = {
        packageExists: false,
        hasVersionHistory: false,
        selectedVersionExists: false,
        latestVersion: null,
      };
    }
    if (
      fault === "root-absent" ||
      fault === "core-companion-absent" ||
      fault === "healthy-with-pending"
    ) {
      observations.pendingAuthority = [
        {
          registry: "npm",
          name: root.name,
          action: "owner-preparation-and-access",
          status: "unresolved",
        },
      ];
    } else {
      assert(source.projection && source.publicationSelection);
      source.projection.packages.push({
        name: "@openclaw/test",
        version: "2026.9.9",
        targets: ["clawhub"],
      });
      source.projection.packages.reverse();
      if (fault.startsWith("prepared-")) {
        source.publicationSelection.route = "prepared";
      }
      const { digest: _digest, ...unsigned } = source;
      source.digest = createHash("sha256").update(publicationSourceJson(unsigned)).digest("hex");
      observations.sourceDigest = source.digest;
      const present = fault !== "prepared-package-absent";
      const published = fault === "configure-as-repair";
      const trusted =
        fault.startsWith("prepared-") && present && fault !== "prepared-missing-normal-trust";
      const publisher =
        trusted || fault === "prepared-missing-normal-trust"
          ? {
              provider: fault === "prepared-wrong-provider" ? "other" : "github-actions",
              repository:
                fault === "prepared-wrong-repository" ? "other/repo" : "openclaw/openclaw",
              workflowFilename:
                fault === "prepared-wrong-workflow" ? "other.yml" : "plugin-clawhub-release.yml",
              environment: fault === "prepared-environment" ? "other" : null,
            }
          : null;
      observations.clawhub = [
        {
          name: "@openclaw/test",
          version: "2026.9.9",
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
        all: [{ name: "@openclaw/test", version: "2026.9.9", alreadyPublished: published }],
        candidates: present && trusted && !published ? ["@openclaw/test"] : [],
        skippedPublished: published ? ["@openclaw/test"] : [],
        bootstrapCandidates: present ? [] : ["@openclaw/test"],
        missingTrustedPublisher: present && !trusted ? ["@openclaw/test"] : [],
        warnings: [],
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
    }
    record.publicationAdmission.binding.sourceDigest = source.digest;
    record.publicationAdmission.binding.observationsDigest = `sha256:${createHash("sha256").update(publicationObservationJson(observations)).digest("hex")}`;
    expect(() =>
      createPublicationAdmission(
        source,
        observations,
        descriptor,
        record.publicationAdmission.binding.admittedAt,
      ),
    ).toThrow(/publication|bootstrap|prepared|authority/u);
    expect(() => validatePublicationAdmissionBinding(record)).toThrow(
      /publication|bootstrap|prepared|authority/u,
    );
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
    ["alpha", "alpha", "2026.9.9-alpha.1", false],
    ["extended-stable", "extended-stable", "2026.8.33", false],
  ] as const)(
    "retains only supported plugin absence on %s/%s/%s (accepted=%s)",
    (route, npmDistTag, version, accepted) => {
      const { source, observations, descriptor, admission } = registryEvidence();
      assert(source.publicationSelection && source.projection);
      source.publicationSelection = {
        ...source.publicationSelection,
        route,
        npmDistTag,
      };
      const rootVersion = route === "alpha" || route === "extended-stable" ? version : "2026.9.9";
      source.projection.version = rootVersion;
      source.projection.packages = [
        { name: "@openclaw/test", version, targets: ["npm"] },
        { name: "openclaw", version: rootVersion, targets: ["npm"] },
      ];
      const { digest: _digest, ...unsigned } = source;
      source.digest = createHash("sha256").update(publicationSourceJson(unsigned)).digest("hex");
      observations.sourceDigest = source.digest;
      const root = observations.npm[0]!;
      observations.npm = [
        {
          name: "@openclaw/test",
          version,
          required: true,
          outcome: "observed",
          observedAt: observations.collectionStartedAt,
          state: {
            packageExists: false,
            hasVersionHistory: false,
            selectedVersionExists: false,
            latestVersion: null,
          },
        },
        { ...root, version: rootVersion },
      ];
      observations.plans.npm = {
        all: [{ name: "@openclaw/test", version, alreadyPublished: false }],
        candidates: ["@openclaw/test"],
        skippedPublished: [],
        warnings: [],
      };
      observations.pendingAuthority = [
        {
          registry: "npm",
          name: "@openclaw/test",
          action: "owner-preparation-and-access",
          status: "unresolved",
        },
      ];
      const create = () =>
        createPublicationAdmission(source, observations, descriptor, admission.binding.admittedAt);
      if (accepted) {
        expect(create().observations.pendingAuthority).toEqual(observations.pendingAuthority);
      } else {
        expect(create).toThrow(/bootstrap/u);
      }
    },
  );

  it("retains distinct root publication history in the actual reused manifest writer and budget", () => {
    const { plan, context } = registryBudgetFixture();
    const root = registryEvidence("99");
    root.observations.prerequisitesCompletedAt = "2026-09-13T13:00:00.000Z";
    root.observations.collectionStartedAt = "2026-09-13T13:00:00.000Z";
    root.observations.collectionCompletedAt = "2026-09-13T13:00:01.000Z";
    root.observations.npm[0]!.observedAt = "2026-09-13T13:00:00.000Z";
    root.record.publicationAdmission = createPublicationAdmission(
      root.source,
      root.observations,
      root.descriptor,
      "2026-09-13T13:00:02.000Z",
    );
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
    const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
    const writer = workflow.jobs.summary.steps.find(
      (step: { name: string }) => step.name === "Write release validation manifest",
    );
    const directory = directories.make("publication-retained-root-");
    const planPath = join(directory, "plan.json");
    const drainPath = join(directory, "drain.json");
    writeFileSync(planPath, serializeReleaseArtifact(carried));
    writeFileSync(drainPath, serializeReleaseArtifact({ children: {} }));
    const result = spawnSync("bash", ["-c", writer.run], {
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.keys(writer.env).map((key) => [key, ""])),
        PATH: process.env.PATH,
        RUNNER_TEMP: directory,
        GITHUB_RUN_ID: context.runId,
        GITHUB_RUN_ATTEMPT: context.runAttempt,
        GITHUB_REF_NAME: context.workflowRef,
        GITHUB_SHA: context.workflowSha,
        GITHUB_REF: context.workflowFullRef,
        GITHUB_REF_TYPE: context.workflowRefType,
        TARGET_REF: context.targetRef,
        RELEASE_PROFILE: context.releaseProfile,
        RERUN_GROUP: context.rerunGroup,
        RUN_RELEASE_SOAK: context.runReleaseSoak,
        RELEASE_EXECUTION_PLAN_PATH: planPath,
        DIAGNOSTIC_DRAIN_PATH: drainPath,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(
        join(directory, "full-release-validation/full-release-validation-manifest.json"),
        "utf8",
      ),
    );
    expect.soft(manifest.evidenceReuse.publication).toEqual(root.record);
    expect(manifest.publicationAdmission).toEqual(plan.publicationAdmission);
    expect(JSON.stringify(sourceManifest)).toBe(originalRoot);
    expect(() => assertReleasePublicationKnownBudget(carried, context)).not.toThrow();
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
    expect(() => serializeReleaseArtifact(largeRoot.record)).not.toThrow();
    expect(() => serializeReleaseArtifact(current.record)).not.toThrow();
    expect(() => buildReleaseValidationManifest({ plan: combined, context })).toThrow(
      /size limit/u,
    );
    expect(() => assertReleasePublicationKnownBudget(combined, context)).toThrow(/size limit/u);
  });

  it("counts complete retained root/current copies and later growth under the same artifact cap", () => {
    const { record } = registryEvidence();
    const root = { ...record, childEvidence: { retained: "x".repeat(520_000) } };
    const current = { ...record, evidenceReuse: { sourceManifest: root } };
    expect(() => serializeReleaseArtifact(root)).not.toThrow();
    expect(() => serializeReleaseArtifact(current)).not.toThrow();
    const enclosing = { ...current, childEvidence: { retained: "x".repeat(520_000) } };
    const emptyBytes = Buffer.byteLength(serializeReleaseArtifact(enclosing));
    enclosing.childEvidence.retained += "x".repeat(MAX_RELEASE_ARTIFACT_BYTES - emptyBytes);
    expect(Buffer.byteLength(serializeReleaseArtifact(enclosing))).toBe(MAX_RELEASE_ARTIFACT_BYTES);
    enclosing.childEvidence.retained += "x";
    expect(() => serializeReleaseArtifact(enclosing)).toThrow(/size limit/u);
    expect(root.publicationAdmission).toEqual(record.publicationAdmission);
    expect(enclosing.publicationAdmission).toEqual(record.publicationAdmission);
  });

  it("reserves JSON escaping of pending bounded fields without truncating later job evidence", () => {
    const { plan, context } = registryBudgetFixture();
    expect(() => assertReleasePublicationKnownBudget(plan, context)).not.toThrow();
    // These are actual carried bytes, not assumed headroom for unknown future jobs.
    const root = {
      ...registryEvidence("99").record,
      retainedDiagnostic: "\0".repeat(65_000),
    };
    const carried = { ...plan, evidenceReuse: { ...plan.evidenceReuse, sourceManifest: root } };
    expect(() => serializeReleaseArtifact(carried)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(root))).toBeGreaterThan(
      root.retainedDiagnostic.length * 5,
    );
    expect(() => assertReleasePublicationKnownBudget(carried, context)).toThrow(/size limit/u);

    const drain = fullMatrixDecision();
    const manifest = buildReleaseValidationManifest({ plan, drain, context });
    const firstChild = Object.values(drain.children)[0]!;
    assert(isRecord(firstChild.timing) && Array.isArray(firstChild.timing.jobs));
    const firstJob = firstChild.timing.jobs[0]!;
    assert(isRecord(firstJob) && typeof firstJob.url === "string");
    assert(isRecord(manifest.childEvidence) && isRecord(manifest.childEvidence.normalCi));
    assert(Array.isArray(manifest.childEvidence.normalCi.jobs));
    const projectedJob = manifest.childEvidence.normalCi.jobs[0];
    assert(isRecord(projectedJob));
    const remaining =
      MAX_RELEASE_ARTIFACT_BYTES - Buffer.byteLength(serializeReleaseArtifact(manifest));
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
    const grownBytes = Buffer.byteLength(
      serializeReleaseArtifact(buildReleaseValidationManifest({ plan, drain, context })),
    );
    firstJob.url += "x".repeat(MAX_RELEASE_ARTIFACT_BYTES - grownBytes);
    expect(firstJob.url.length).toBeLessThanOrEqual(1024);
    expect(
      Buffer.byteLength(
        serializeReleaseArtifact(buildReleaseValidationManifest({ plan, drain, context })),
      ),
    ).toBe(MAX_RELEASE_ARTIFACT_BYTES);
    firstJob.url += "x";
    expect(() => buildReleaseValidationManifest({ plan, drain, context })).toThrow(/size limit/u);
    expect(firstChild.timing.jobs).toHaveLength(186 + count);
    expect(plan.publicationAdmission).toEqual(registryEvidence().admission);
  });

  it.each([false, true])(
    "budgets the actual reuse handoff before selected edges (combined oversize=%s)",
    (oversize) => {
      const { record, source, candidateRequest } = registryBudgetFixture(oversize ? 140 : 0);
      const root = registryEvidence("99", oversize ? 140 : 0).record;
      expect(() => serializeReleaseArtifact(record)).not.toThrow();
      expect(() => serializeReleaseArtifact(root)).not.toThrow();
      const directory = directories.make("publication-reuse-budget-");
      mkdirSync(join(directory, "full-release-publication-admission"));
      writeFileSync(
        join(directory, "full-release-publication-admission/publication-admission.json"),
        serializeReleaseArtifact(record),
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
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
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
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_REPOSITORY: "openclaw/openclaw",
            GITHUB_SHA: SHA,
            GITHUB_REF_NAME: "release-ci/test",
            GITHUB_REF: "refs/heads/release-ci/test",
            GITHUB_REF_TYPE: "branch",
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
          "docker_runtime_assets_preflight",
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
});

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

describe("full release artifact contract", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function runDispatchWitness(event: unknown, rawEvent?: string) {
    const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
    const steps = workflow.jobs.resolve_target.steps;
    const writer = steps.find((step: { id?: string }) => step.id === "dispatch_witness");
    const dir = tempDirs.make("full-release-dispatch-inputs-");
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

  it.each([false, true])("writes only a full-input digest and safe context (soak=%s)", (soak) => {
    const privateValue = "/private/example/operator/candidate.tgz";
    const secretValue = "synthetic-private-dispatch-value";
    const shellValue = 'line one\n$(touch unexpected) "quoted"';
    const { result, bytes, context, dir, workflow, writer, steps } = runDispatchWitness({
      inputs: {
        text: shellValue,
        secret: secretValue,
        package: privateValue,
        run_release_soak: String(soak),
        count: 3,
        empty: "",
      },
    });
    const canonical = JSON.stringify({
      count: "3",
      empty: "",
      package: privateValue,
      run_release_soak: String(soak),
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
      expect(bytes + result.stdout + result.stderr + JSON.stringify(writer.env)).not.toContain(
        value,
      );
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
    const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
    const definitions = workflow.on.workflow_dispatch.inputs as Record<
      string,
      { default?: unknown }
    >;
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
    {
      name: "oversized event",
      event: { inputs: {}, padding: "x".repeat(1024 * 1024) },
      error: "Invalid or oversized root dispatch event",
    },
    {
      name: "oversized inputs",
      event: { inputs: { payload: "x".repeat(129 * 1024) } },
      error: "Root dispatch inputs exceed their byte limit",
    },
    {
      name: "nested inputs",
      event: { inputs: { payload: { private: "synthetic-private-dispatch-value" } } },
      error: "Invalid root dispatch inputs",
    },
    {
      name: "malformed event",
      event: {},
      rawEvent: '{"inputs":"synthetic-private-dispatch-value',
      error: "Invalid or oversized root dispatch event",
    },
  ])(
    "refuses $name without a partial artifact or raw values in logs",
    ({ event, rawEvent, error }) => {
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
    ({ reuse, source }) => {
      const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
      const writer = workflow.jobs.summary.steps.find(
        (entry: { name: string }) => entry.name === "Write release validation manifest",
      );
      const children = fullMatrixChildren();
      const drain = fullMatrixDecision(children);
      const expectedChildren = Object.fromEntries(
        children.map((child) => [
          child.key,
          {
            runId: child.runId,
            plannedRunAttempt: child.plannedRunAttempt,
            effectiveRunAttempt: child.runAttempt,
            observedRunAttempts: child.observedRunAttempts,
            compositeJobsSha256: child.compositeJobsSha256,
            dispatchActor: child.dispatchActor,
            triggeringActor: child.triggeringActor,
            repository: child.repository,
            jobs: child.jobs.map(
              ({ name, status, conclusion, acceptedRunAttempt, startedAt, completedAt, url }) => ({
                name,
                status,
                conclusion,
                acceptedRunAttempt,
                startedAt,
                completedAt,
                url,
              }),
            ),
          },
        ]),
      );
      expect(Buffer.byteLength(JSON.stringify(expectedChildren))).toBeGreaterThan(128 * 1024);
      const request = publicationSourceRequest({
        PUBLICATION_INPUTS_JSON: JSON.stringify({
          ref: SHA,
          release_profile: "full",
          rerun_group: "all",
          provider: "openai",
          trusted_workflow_json: publicationDispatchEnvelope(null, {
            validationPurpose: "publish",
            publicationSelection: {
              route: "normal",
              npmDistTag: "latest",
              publishOpenclawNpm: true,
              pluginPublishScope: "all-publishable",
              plugins: [],
            },
          }),
        }),
        PUBLICATION_TOOLING_JSON: JSON.stringify({
          fullRef: "refs/heads/main",
          sha: "d".repeat(40),
        }),
        PUBLICATION_TARGET_CONTEXT: "release/2026.9.9",
        PUBLICATION_TARGET_SHA: SHA,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_REF: "refs/heads/release-ci/test",
        GITHUB_SHA: "d".repeat(40),
        GITHUB_RUN_ID: "124",
        GITHUB_RUN_ATTEMPT: "1",
      });
      const inventory = { packages: [], platforms: [] };
      const projection = {
        version: "2026.9.9",
        packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
        platforms: [],
      };
      const sourceAdmission = createPublicationSourceFact(request, inventory, projection);
      const oldSource = createPublicationSourceFact(
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
      const dir = tempDirs.make("full-release-manifest-");
      const planPath = join(dir, "plan.json");
      const drainPath = join(dir, "drain.json");
      writeFileSync(planPath, serializeReleaseArtifact(plan));
      writeFileSync(drainPath, serializeReleaseArtifact(drain));
      const result = spawnSync("bash", ["-c", writer.run], {
        encoding: "utf8",
        env: {
          ...Object.fromEntries(Object.keys(writer.env).map((key) => [key, ""])),
          EXTENSION_TEST_EXCLUDE_PATTERNS_JSON: "[]",
          PATH: process.env.PATH,
          RUNNER_TEMP: dir,
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
          RELEASE_EXECUTION_PLAN_PATH: planPath,
          DIAGNOSTIC_DRAIN_PATH: drainPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const bytes = readFileSync(
        join(dir, "full-release-validation/full-release-validation-manifest.json"),
        "utf8",
      );
      expect(Buffer.byteLength(bytes)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
      const manifest = JSON.parse(bytes);
      if (source) {
        expect(
          validatePublicationSourceBinding(manifest, { sourceAdmissionContract: "1" }),
        ).toEqual(sourceAdmission);
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
    const compact = serializeReleaseArtifact(payload);
    expect(JSON.parse(compact)).toEqual(payload);
    expect(Buffer.byteLength(compact)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(compact)).toBeLessThan(MAX_RELEASE_ARTIFACT_BYTES);
    expect(compact.split("\n")).toHaveLength(2);

    const value = "x".repeat(
      MAX_RELEASE_ARTIFACT_BYTES - Buffer.byteLength(serializeReleaseArtifact({ value: "" })),
    );
    expect(Buffer.byteLength(serializeReleaseArtifact({ value }))).toBe(MAX_RELEASE_ARTIFACT_BYTES);
    expect(() => serializeReleaseArtifact({ value: `${value}é` })).toThrow("size limit");
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

  it.each(["dispatch helper", "summary watcher"])(
    "%s reads every job in the full release matrix",
    (reader) => {
      const payload = fullMatrixDecision();
      const serialized = JSON.stringify(payload, null, 2);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
      const download = (args: string[]) => {
        writeFileSync(
          join(args[args.indexOf("--dir") + 1]!, "full-release-decision.json"),
          serialized,
        );
      };
      const result =
        reader === "dispatch helper"
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
      expect(result).toEqual(payload);
    },
  );

  it.each(["dispatch helper", "summary watcher"])(
    "%s rejects oversized evidence before parsing it",
    (reader) => {
      const download = (args: string[]) => {
        writeFileSync(
          join(args[args.indexOf("--dir") + 1]!, "full-release-decision.json"),
          " ".repeat(MAX_RELEASE_ARTIFACT_BYTES + 1),
        );
      };
      expect(() =>
        reader === "dispatch helper"
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
            ),
      ).toThrow("size limit");
    },
  );
});
