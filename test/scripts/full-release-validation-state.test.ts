import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFullReleaseCandidateBinding } from "../../scripts/full-release-candidate-contract.mjs";
import { publicationIntentInputs } from "../../scripts/full-release-publication-contract.mjs";
import {
  composeReleaseAttemptJobs,
  buildReleaseValidationManifest,
  isReleaseGhArtifactMissingError,
  MAX_RELEASE_ARTIFACT_BYTES,
  releaseExecutionPlanSha256,
  terminalPolicyPass,
  validateReleaseChildDispatchBinding,
  validateReleaseCoveragePolicyBinding,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  affectedActiveRunIds,
  buildReleaseStateArtifact,
  classifyReleaseSnapshot,
  formatReleaseStateOutcome,
  hydrateReusedPlan,
  readChild,
  releaseGhRetryDelayMs,
  serializeReleaseArtifact,
  selectReleaseStateArtifacts,
  validateReleaseExecutionPlanArtifact,
  validateReleaseStateArtifact,
  verifyReleaseStateArtifacts,
  updateReleaseTransportEpisode,
} from "../../scripts/full-release-validation-state.mjs";
import { hasErrnoCode } from "../../src/infra/errno.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { fullReleaseCandidateManifestFixture } from "../helpers/full-release-candidate.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  SCRIPT,
  SHA,
  TARGET_SHA,
  TRUSTED_MAIN,
  collectorEnv,
  runCollector,
  candidateRequestInput,
  canonicalCandidateRequest,
  candidateBinding,
  evidenceManifest,
  generatedManifest,
  child,
  githubRun,
  plan,
  executionPlan,
  reusedEvidenceChildren,
  sourceFact,
  registryRecord,
} from "./full-release-validation-state.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runPlanSubprocess(overrides: Record<string, unknown>, env: Record<string, string> = {}) {
  const root = tempDirs.make("frv-candidate-plan-");
  const output = join(root, "full-release-execution-plan.json");
  const planInputs = planInput(overrides);
  const result = runCollector("plan", {
    FULL_RELEASE_EXECUTION_PLAN_PATH: output,
    FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(planInputs),
    GITHUB_RUN_ATTEMPT: "1",
    RERUN_GROUP: planInputs.rerunGroup,
    ...env,
  });
  return { output, result };
}

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    candidateBindingResult: "skipped",
    candidateRequestInput: canonicalCandidateRequest(),
    children: {},
    dockerPreflightResult: "success",
    evidenceReuse: false,
    parentRunAttempt: 1,
    parentRunId: "77",
    rerunGroup: "all",
    resolveTargetResult: "success",
    trustedWorkflow: TRUSTED_MAIN,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
    ...overrides,
  };
}

function collectorArtifact(
  mode: "decision" | "drain",
  parentRunAttempt = 2,
  sealedPlan = executionPlan({ rerunGroup: "ci" }),
  childOverrides: Record<string, unknown> = {},
  options: Record<string, any> = {},
) {
  const plannedChild = sealedPlan.children.find(
    (entry: Record<string, any>) => entry.key === "normalCi",
  );
  const children = [
    child("normalCi", {
      ...plannedChild,
      conclusion: "success",
      createdAt: "2026-08-21T00:00:00Z",
      status: "completed",
      updatedAt: "2026-08-21T00:01:00Z",
      ...childOverrides,
    }),
  ];
  const cancellation = options.cancellation ?? {};
  const decision = classifyReleaseSnapshot({
    cancelled: cancellation.requested === true,
    children,
    extraBlockers: options.extraBlockers,
    extraErrors: options.extraErrors,
    releaseProfile: "stable",
    workflowRef: "release-ci/tooling",
  });
  return buildReleaseStateArtifact({
    cancellation,
    children,
    decision,
    executionPlan: sealedPlan,
    expected: {
      parentRunAttempt,
      parentRunId: "77",
      targetSha: TARGET_SHA,
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    },
    mode,
    releaseProfile: "stable",
    rerunGroup: "ci",
    transport: options.transport,
  });
}

describe("full release execution plan", () => {
  it("seals mixed child reuse identities without replacing fresh children or current admission", () => {
    const original = executionPlan(
      { childPhaseVersion: 3 },
      {
        attemptEvidenceVersion: 3,
        candidateRequest: canonicalCandidateRequest(),
      },
    );
    const selection = {
      repository: "openclaw/openclaw",
      targetSha: TARGET_SHA,
      role: "normalCi",
      runId: "999",
      runAttempt: 2,
      workflowSha: SHA,
      workflowRef: "main",
      displayTitle: "CI full-release-validation-88-1-ci",
      sourceParentRunId: "88",
      sourceParentAttempt: 1,
      url: "https://github.com/openclaw/openclaw/actions/runs/999",
      receiptSha256: "d".repeat(64),
      inputs: { target_ref: TARGET_SHA },
      artifact: { id: "701" },
    };
    const childReuse = { normalCi: selection };
    const hydrated = hydrateReusedPlan(original.children, { childReuse });
    expect(hydrated[0]).toMatchObject({
      runId: "999",
      runAttempt: 1,
      source: "reused",
      workflowSha: SHA,
    });
    expect(hydrated.slice(1)).toEqual(original.children.slice(1));
    const sealed = { ...original, childReuse, children: hydrated };
    sealed.sha256 = releaseExecutionPlanSha256(sealed);
    expect(validateReleaseExecutionPlanArtifact(sealed)).toMatchObject({
      parentRunId: "77",
      targetSha: TARGET_SHA,
      workflowSha: SHA,
      childReuse,
    });
    expect(() =>
      validateReleaseExecutionPlanArtifact({
        ...sealed,
        childReuse: { normalCi: { ...selection, runAttempt: 3 } },
      }),
    ).toThrow("digest");
    const mismatched = {
      ...sealed,
      childReuse: { normalCi: { ...selection, workflowSha: "c".repeat(40) } },
    };
    mismatched.sha256 = releaseExecutionPlanSha256(mismatched);
    expect(() => validateReleaseExecutionPlanArtifact(mismatched)).toThrow("immutable plan");
    const changedTarget = {
      ...sealed,
      childReuse: { normalCi: { ...selection, inputs: { target_ref: SHA } } },
    };
    changedTarget.sha256 = releaseExecutionPlanSha256(changedTarget);
    expect(() => validateReleaseExecutionPlanArtifact(changedTarget)).toThrow(
      "target or candidate",
    );

    const root = tempDirs.make("release-reuse-plan-cli-");
    const gh = join(root, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' '{\"run_attempt\":3}'\n");
    chmodSync(gh, 0o755);
    const { output, result } = runPlanSubprocess(
      { childPhaseVersion: 3, childReuse },
      {
        PATH: `${root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not bind reusable evidence");
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      childReuse,
      children: expect.arrayContaining([
        expect.objectContaining({ key: "normalCi", runId: "999", source: "reused" }),
      ]),
      blockers: [expect.objectContaining({ kind: "reused_evidence_invalid" })],
    });
    const differentTooling = runPlanSubprocess(
      {
        childPhaseVersion: 3,
        childReuse: { normalCi: { ...selection, workflowSha: "c".repeat(40) } },
      },
      { PATH: `${root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
    );
    expect(differentTooling.result.status).toBe(2);
    expect(JSON.parse(readFileSync(differentTooling.output, "utf8"))).toMatchObject({
      blockers: [
        expect.objectContaining({
          kind: "reused_evidence_invalid",
          message: expect.stringContaining("same tooling is required"),
        }),
      ],
    });
    writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' 'HTTP 503: Service unavailable' >&2\nexit 1\n");
    const unavailable = runPlanSubprocess(
      { childPhaseVersion: 3, childReuse },
      {
        PATH: `${root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      },
    );
    expect(unavailable.result.status).toBe(2);
    expect(JSON.parse(readFileSync(unavailable.output, "utf8"))).toMatchObject({
      blockers: [],
      errors: [expect.objectContaining({ kind: "api_error" })],
    });
  });

  it("rejects a new attempt of an independently reused child without cancelling the prior parent's work", async () => {
    const reused = child("normalCi", { source: "reused" });
    const observed = await readChild(reused, undefined, undefined, {
      reuseSelection: { runAttempt: 1 },
      readRun: async () => ({ run_attempt: 2 }),
      readAttemptJobs: async () => {
        throw new Error("must not read stale jobs");
      },
    });
    expect(observed.errors).toEqual([
      expect.objectContaining({
        kind: "provenance_mismatch",
        message: expect.stringContaining("reused attempt is stale"),
      }),
    ]);
    expect(affectedActiveRunIds([reused], [{ runId: "101" }])).toEqual([]);
  });

  it("retains the published empty retry field in the original execution-plan digest", () => {
    const current = executionPlan(
      { childPhaseVersion: 3, rerunGroup: "ci" },
      { attemptEvidenceVersion: 3, candidateRequest: canonicalCandidateRequest() },
    );
    // The published v2026.9.6 artifact hashes this ordered wire shape.
    const digestPayload = {
      knownFlakyJobs: [],
      ...Object.fromEntries(
        [
          "attemptEvidenceVersion",
          "blockers",
          "candidate",
          "candidateRequest",
          "children",
          "errors",
          "evidenceReuse",
          "gates",
          "kind",
          "parentRunAttempt",
          "parentRunId",
          "releaseProfile",
          "repository",
          "rerunGroup",
          "targetSha",
          "trustedWorkflow",
          "version",
          "workflowRef",
          "workflowSha",
        ].map((key) => [key, current[key]]),
      ),
    };
    const retained = {
      ...current,
      knownFlakyJobs: [],
      sha256: createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex"),
    };
    const before = JSON.stringify(retained);
    expect(validateReleaseExecutionPlanArtifact(retained)).toEqual(retained);
    expect(JSON.stringify(retained)).toBe(before);
    expect(retained.sha256).not.toBe(current.sha256);
    expect(() =>
      validateReleaseExecutionPlanArtifact({ ...retained, knownFlakyJobs: ["normalCi:test"] }),
    ).toThrow("knownFlakyJobs must be empty");
    expect(() =>
      validateReleaseExecutionPlanArtifact({ ...retained, knownFlakyJobs: undefined }),
    ).toThrow("knownFlakyJobs must be empty");
  });

  it("retains B observations and post-upload binding through completed plan sealing", () => {
    const record = registryRecord();
    const directory = tempDirs.make("publication-plan-");
    const receipt = join(directory, "admission.json");
    writeFileSync(receipt, JSON.stringify(record));
    const { output, result } = runPlanSubprocess(record, {
      FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1",
      FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1",
      PUBLICATION_ADMISSION_PATH: receipt,
    });
    expect(result.status, result.stderr).toBe(0);
    const sealed = validateReleaseExecutionPlanArtifact(JSON.parse(readFileSync(output, "utf8")), {
      publicationAdmissionContract: "1",
    });
    expect(sealed).toMatchObject(record);
    expect(readFileSync(receipt, "utf8")).toBe(JSON.stringify(record));
  });
  it("seals and restores source admission without reevaluation and rejects deleted support", () => {
    const sourceAdmission = sourceFact();
    const { output, result } = runPlanSubprocess(
      {
        sourceAdmissionContract: "1",
        sourceAdmission,
      },
      { FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1" },
    );
    expect(result.status, result.stderr).toBe(0);
    const bytes = readFileSync(output, "utf8");
    const sealed = JSON.parse(bytes);
    expect(sealed.sourceAdmission).toEqual(sourceAdmission);
    const restore = (attempt = "2") =>
      runCollector("plan", {
        FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1",
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_RESTORE_PLAN: "true",
        FULL_RELEASE_PLAN_INPUTS_JSON: "must-not-be-read",
        CANDIDATE_REQUEST_JSON: JSON.stringify(canonicalCandidateRequest()),
        GITHUB_RUN_ATTEMPT: attempt,
        RERUN_GROUP: "all",
      });
    const restored = restore();
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(bytes);
    const third = restore("3");
    expect(third.status, third.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(bytes);
    delete sealed.sourceAdmissionContract;
    delete sealed.sourceAdmission;
    sealed.sha256 = releaseExecutionPlanSha256(sealed);
    writeFileSync(output, JSON.stringify(sealed));
    const missing = restore();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("source admission contract missing");
  });

  const betaCoverage = {
    coveragePolicy: "npm-beta-v1",
    releaseProfile: "beta",
    rerunGroup: "all",
    runReleaseSoak: false,
    targetVersion: "2026.8.28-beta.1",
  };
  const stableCoverage = {
    coveragePolicy: "npm-stable-v1",
    releaseProfile: "stable",
    rerunGroup: "all",
    runReleaseSoak: true,
    targetVersion: "2026.8.28",
  };

  it("keeps every OS Gateway lane in all-group coverage: stable", () => {
    const coverage = stableCoverage;
    const unfiltered = plan(coverage);
    for (const crossOsSuiteFilter of [
      "ubuntu,windows,macos",
      "packaged-fresh,installer-fresh,packaged-upgrade",
    ]) {
      expect(plan({ ...coverage, crossOsSuiteFilter })).toEqual(unfiltered);
    }
    for (const crossOsSuiteFilter of [
      "ubuntu",
      "ubuntu,macos",
      "ubuntu/packaged-fresh,ubuntu/installer-fresh,ubuntu/packaged-upgrade",
      "windows,macos",
      "packaged-fresh",
      "ubuntu/packaged-upgrade",
    ]) {
      expect(() => plan({ ...coverage, crossOsSuiteFilter })).toThrow(
        /all Linux, Windows, and macOS cross-OS suites/u,
      );
    }
  });

  function coveragePlan(coverage = betaCoverage) {
    const request = {
      releaseProfile: coverage.releaseProfile,
      releaseSoak: coverage.runReleaseSoak,
    };
    const manifest = fullReleaseCandidateManifestFixture(candidateRequestInput(request));
    manifest.package.version = coverage.targetVersion;
    const candidate = buildFullReleaseCandidateBinding({
      manifest,
      artifact: candidateBinding(request).evidenceArtifact,
    });
    return executionPlan(
      { ...coverage, childPhaseVersion: 3, children: {} },
      {
        ...coverage,
        attemptEvidenceVersion: 3,
        candidate,
        candidateRequest: candidate.request,
      },
    );
  }

  it("defers only confidence children under explicit npm beta coverage", () => {
    const input = {
      ...betaCoverage,
      childPhaseVersion: 3,
      children: {},
      releasePackageSpec: "openclaw@2026.8.28-beta.1",
    };
    const historical = plan({ ...input, coveragePolicy: undefined });
    const bounded = plan(input);
    expect(bounded.children.filter((entry) => entry.selected).map((entry) => entry.key)).toEqual(
      historical.children
        .filter(
          (entry) => entry.selected && !["productPerformance", "npmTelegram"].includes(entry.key),
        )
        .map((entry) => entry.key),
    );
    expect(bounded.gates).toEqual(historical.gates);
    for (const key of ["productPerformance", "npmTelegram"]) {
      expect(historical.children.find((entry) => entry.key === key)).toMatchObject({
        required: true,
        selected: true,
      });
      expect(bounded.children.find((entry) => entry.key === key)).toMatchObject({
        required: false,
        selected: false,
        result: "skipped",
        runId: "",
        runAttempt: null,
        url: "",
      });
    }
  });

  it("rejects npm beta coverage when soak is required", () => {
    const override = { runReleaseSoak: true };
    expect(() =>
      plan({ ...betaCoverage, childPhaseVersion: 3, children: {}, ...override }),
    ).toThrow(/coverage policy/u);
  });

  it("binds npm beta coverage to the immutable plan, version, and manifest", () => {
    const artifact = coveragePlan();
    expect(validateReleaseExecutionPlanArtifact(artifact)).toMatchObject({
      coveragePolicy: "npm-beta-v1",
      targetVersion: betaCoverage.targetVersion,
    });
    expect(() => validateReleaseCoveragePolicyBinding(artifact, betaCoverage)).not.toThrow();
    expect(() => validateReleaseCoveragePolicyBinding(artifact, {})).toThrow(/coverage policy/u);
    expect(() =>
      validateReleaseCoveragePolicyBinding(artifact, {
        ...betaCoverage,
        targetVersion: "2026.8.28-beta.2",
      }),
    ).toThrow(/coverage policy/u);
    expect(() =>
      validateReleaseExecutionPlanArtifact({ ...artifact, coveragePolicy: "unknown" }),
    ).toThrow(/digest/u);
    const changed = { ...artifact, targetVersion: "2026.8.28-beta.2" };
    expect(() =>
      validateReleaseExecutionPlanArtifact({
        ...changed,
        sha256: releaseExecutionPlanSha256(changed),
      }),
    ).toThrow(/coverage policy/u);
    for (const key of ["productPerformance", "npmTelegram"]) {
      const forged = structuredClone(artifact);
      Object.assign(
        forged.children.find((entry) => entry.key === key)!,
        { selected: true, required: true, runId: "900", runAttempt: 1, result: "success" },
      );
      forged.sha256 = releaseExecutionPlanSha256(forged);
      expect(() => validateReleaseExecutionPlanArtifact(forged)).toThrow(/coverage policy/u);
    }
  });

  it.each([
    { runReleaseSoak: false },
    { targetVersion: "2026.8.33" },
    { targetVersion: "2026.13.28" },
  ])("rejects npm stable coverage outside its qualification scope: %j", (override) => {
    expect(() => plan({ ...stableCoverage, ...override })).toThrow(/coverage policy/u);
  });

  it.each([
    ["npm-beta-v1", "", false],
    ["npm-stable-v1", "npm-stable", true],
    [undefined, "", true],
  ])(
    "binds normal CI dispatch scope to release coverage %s/%s",
    (coveragePolicy, scope, accepted) => {
      const verify = () =>
        validateReleaseChildDispatchBinding({
          child: { key: "normalCi", runId: "101" },
          plannedRunAttempt: 1,
          repository: "openclaw/openclaw",
          targetSha: TARGET_SHA,
          coveragePolicy,
          log: `TARGET_SHA: ${TARGET_SHA}\n${scope ? `CI_RELEASE_SCOPE: ${scope}\n` : ""}Dispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/101 (attempt 1)`,
        });
      if (accepted) {
        expect(verify).not.toThrow();
      } else {
        expect(verify).toThrow(/scope/u);
      }
    },
  );

  it.each([{ liveSuiteFilter: "TELEGRAM" }, { releasePackageSpec: "openclaw@2026.8.2" }])(
    "rejects a Telegram waiver outside its owner-approved scope: %j",
    (override) => {
      expect(() =>
        plan({
          telegramWaiver: "2026.8.1-owner-approved",
          targetVersion: "2026.8.1",
          releaseProfile: "stable",
          ...override,
        }),
      ).toThrow(/Telegram waiver/u);
    },
  );

  it("seals the Telegram waiver and exact version 2026.9.5 into the immutable plan", () => {
    const version = "2026.9.5";
    const waiver = { telegramWaiver: `${version}-owner-approved`, targetVersion: version };
    const artifact = executionPlan(
      {
        ...waiver,
        releaseProfile: "stable",
        releasePackageSpec: `openclaw@${version}`,
        children: {},
      },
      waiver,
    );
    expect(validateReleaseExecutionPlanArtifact(artifact)).toMatchObject(waiver);
    for (const result of ["success", "failure"]) {
      const claimed = {
        ...artifact,
        children: artifact.children.map((plannedChild) =>
          plannedChild.key === "npmTelegram" ? { ...plannedChild, result } : plannedChild,
        ),
      };
      expect(() =>
        validateReleaseExecutionPlanArtifact({
          ...claimed,
          sha256: releaseExecutionPlanSha256(claimed),
        }),
      ).toThrow("Telegram waiver requires an unrun Telegram child");
    }
    const changed = { ...artifact, targetVersion: "2026.8.2" };
    expect(() => validateReleaseExecutionPlanArtifact(changed)).toThrow(/digest/u);
    expect(() =>
      validateReleaseExecutionPlanArtifact({
        ...changed,
        sha256: releaseExecutionPlanSha256(changed),
      }),
    ).toThrow(/Telegram waiver/u);
    expect(() => validateReleaseExecutionPlanArtifact(artifact, { telegramWaiver: "" })).toThrow(
      /Telegram waiver/u,
    );
    const candidate = candidateBinding();
    expect(() =>
      executionPlan(
        { ...waiver, releaseProfile: "stable", children: {} },
        { ...waiver, attemptEvidenceVersion: 2, candidate, candidateRequest: candidate.request },
      ),
    ).toThrow("Telegram waiver target version differs from the release candidate");
    const manifest = fullReleaseCandidateManifestFixture(candidateRequestInput());
    manifest.package.version = version;
    const matchingCandidate = buildFullReleaseCandidateBinding({
      manifest,
      artifact: candidate.evidenceArtifact,
    });
    const sealedCandidatePlan = executionPlan(
      { ...waiver, releaseProfile: "stable", children: {} },
      {
        ...waiver,
        attemptEvidenceVersion: 2,
        candidate: matchingCandidate,
        candidateRequest: matchingCandidate.request,
      },
    );
    expect(validateReleaseExecutionPlanArtifact(sealedCandidatePlan)).toMatchObject(waiver);
  });

  it.each([
    ["target", { targetSha: "c".repeat(40) }],
    ["soak", { releaseSoak: false }],
  ])("cross-binds candidate %s policy during plan build and validation", (_label, override) => {
    const expectedCandidate = candidateBinding();
    const mismatchedCandidate = candidateBinding(override);
    expect(() =>
      executionPlan(
        {},
        {
          attemptEvidenceVersion: 2,
          candidate: mismatchedCandidate,
          candidateRequest: expectedCandidate.request,
        },
      ),
    ).toThrow("release candidate binding request differs from the execution plan");

    const valid = executionPlan(
      {},
      {
        attemptEvidenceVersion: 2,
        candidate: expectedCandidate,
        candidateRequest: expectedCandidate.request,
      },
    );
    const forged: Record<string, any> = {
      ...valid,
      candidate: mismatchedCandidate,
    };
    forged.sha256 = releaseExecutionPlanSha256(forged);
    expect(() => validateReleaseExecutionPlanArtifact(forged)).toThrow(
      "release candidate binding request differs from the execution plan",
    );

    const forgedExpectedTuple: Record<string, any> = {
      ...valid,
      candidate: mismatchedCandidate,
      candidateRequest: mismatchedCandidate.request,
    };
    forgedExpectedTuple.sha256 = releaseExecutionPlanSha256(forgedExpectedTuple);
    expect(() =>
      validateReleaseExecutionPlanArtifact(forgedExpectedTuple, {
        candidateRequest: expectedCandidate.request,
      }),
    ).toThrow(
      /release candidate request differs from the (execution plan identity|expected plan inputs)/u,
    );
  });

  it("recognizes recursive missing-artifact output", () => {
    const message = "no artifact matches any of the names or patterns provided";
    const error = Object.assign(new Error("gh run download failed"), {
      cause: Object.assign(new Error("download command failed"), { stderr: message }),
    });
    expect(isReleaseGhArtifactMissingError(error)).toBe(true);
  });

  it.each(["error fetching artifacts: HTTP 401: Bad credentials", "artifact archive is malformed"])(
    "does not turn fatal artifact errors into absence: %s",
    (message) => {
      const error = Object.assign(new Error(message), {
        cause: new Error("no artifact matches any of the names or patterns provided"),
        stderr: message,
      });
      expect(isReleaseGhArtifactMissingError(error)).toBe(false);
    },
  );

  it("keeps required coverage selected when dispatch output is missing", () => {
    const result = plan({
      children: { normalCi: { result: "success", runAttempt: "", runId: "" } },
      rerunGroup: "ci",
    });
    expect(result.children.find((entry) => entry.key === "normalCi")).toMatchObject({
      required: true,
      runAttempt: null,
      runId: "",
      selected: true,
    });
    expect(
      classifyReleaseSnapshot({
        children: result.children.map((entry) =>
          Object.assign({}, entry, { errors: [], jobs: [], status: "missing" }),
        ),
        releaseProfile: "stable",
        workflowRef: "release-ci/tooling",
      }),
    ).toMatchObject({
      blockers: [expect.objectContaining({ kind: "dispatch_missing" })],
      state: "blocked_complete",
    });
  });

  it("does not require candidate acquisition when reusing release evidence", () => {
    expect(
      plan({
        candidateAcquisitionResult: "skipped",
        candidateRequired: true,
        childPhaseVersion: 3,
        evidenceReuse: true,
      }).gates.at(-1),
    ).toMatchObject({
      name: "Acquire full release candidate",
      required: false,
      result: "skipped",
    });
  });

  it("requires live-e2e candidate preparation only without a suite filter", () => {
    expect(plan({ rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject({ required: true });
    expect(plan({ liveSuiteFilter: "discord", rerunGroup: "live-e2e" }).gates.at(-1)).toMatchObject(
      {
        required: false,
      },
    );
  });

  it("rejects subprocess candidate target mismatch against trusted plan inputs", () => {
    const override = { targetSha: "c".repeat(40) };
    const { result } = runPlanSubprocess({
      candidateBindingResult: "success",
      candidateEvidence: candidateBinding(override),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "release candidate binding request differs from the execution plan",
    );
  });

  it("rejects successful required candidate binding without evidence", () => {
    const { result } = runPlanSubprocess({ candidateBindingResult: "success" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "successful release candidate binding omitted producer evidence",
    );
  });

  it("rejects candidate evidence when required binding is skipped", () => {
    const { result } = runPlanSubprocess({
      candidateBindingResult: "skipped",
      candidateEvidence: candidateBinding(),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("release candidate evidence exists without successful binding");
  });

  it("rejects candidate evidence when binding is not required", () => {
    const { result } = runPlanSubprocess({
      candidateBindingResult: "success",
      candidateEvidence: candidateBinding(),
      rerunGroup: "ci",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "release candidate evidence exists when candidate binding is not required",
    );
  });

  it("rejects a digest-valid plan with an incomplete reuse selection tuple", () => {
    const artifact = executionPlan(
      { rerunGroup: "ci" },
      {
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: TARGET_SHA,
          policy: "exact-target-full-validation-v1",
          requested: true,
          rootRunId: "99",
          runUrl: "https://example.invalid/runs/99",
          selectedRunId: "99",
          sourceManifest: evidenceManifest(),
        },
      },
    );
    const incompleteArtifact = {
      ...artifact,
      evidenceReuse: { ...artifact.evidenceReuse, selectedRunId: "" },
    };
    const digestValidArtifact = {
      ...incompleteArtifact,
      sha256: releaseExecutionPlanSha256(incompleteArtifact),
    };
    expect(() => validateReleaseExecutionPlanArtifact(digestValidArtifact)).toThrow(
      "release execution plan evidence reuse binding is invalid",
    );
  });
});

describe("release child attempt composition", () => {
  const job = (name: string, conclusion: string) => ({
    completed_at: "2026-08-22T00:01:00Z",
    conclusion,
    html_url: `https://example.invalid/jobs/${name}`,
    name,
    started_at: "2026-08-22T00:00:00Z",
    status: "completed",
  });

  it("ignores terminal skipped jobs before duplicate identity checks", () => {
    const matrixPlaceholder = job("matrix.check_name", "skipped");
    const skippedJob = job("disabled-check", "skipped");
    const result = composeReleaseAttemptJobs(
      [
        {
          jobs: [
            matrixPlaceholder,
            matrixPlaceholder,
            skippedJob,
            skippedJob,
            job("test", "success"),
          ],
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    expect(result.jobs).toEqual([
      expect.objectContaining({ acceptedRunAttempt: 1, conclusion: "success", name: "test" }),
    ]);
  });

  describe("GitHub ghost rerun jobs", () => {
    // Shape observed on 2026.9.7 FRV-E CI attempt 2: one rerun-failed POST left 17
    // queued copies with no runner or steps beside the completed job.
    const ghost = {
      completed_at: null,
      conclusion: null,
      html_url: "https://example.invalid/jobs/ghost",
      name: "checks-node-core-runtime-infra-process",
      runner_id: null,
      runner_name: null,
      started_at: "2026-09-29T20:38:30Z",
      status: "queued",
      steps: [],
    };
    const completed = {
      ...job("checks-node-core-runtime-infra-process", "success"),
      runner_id: 1,
      runner_name: "GitHub Actions 1",
      steps: [{ name: "Run tests" }],
    };
    const ghostAttempt = {
      jobs: [ghost, completed, ghost, job("checks-ui", "failure")],
      runAttempt: 2,
    };

    it("ignores never-executed copies beside a completed job in a superseded attempt", () => {
      const result = composeReleaseAttemptJobs(
        [
          {
            jobs: [
              job("checks-node-core-runtime-infra-process", "failure"),
              job("checks-ui", "failure"),
            ],
            runAttempt: 1,
          },
          ghostAttempt,
          { jobs: [job("checks-ui", "success")], runAttempt: 3 },
        ],
        { effectiveRunAttempt: 3, plannedRunAttempt: 1 },
      );
      expect(result.jobs).toEqual([
        expect.objectContaining({
          acceptedRunAttempt: 2,
          conclusion: "success",
          name: "checks-node-core-runtime-infra-process",
        }),
        expect.objectContaining({
          acceptedRunAttempt: 3,
          conclusion: "success",
          name: "checks-ui",
        }),
      ]);
    });

    it.each<{
      label: string;
      attempts: Parameters<typeof composeReleaseAttemptJobs>[0];
      effectiveRunAttempt: number;
      plannedRunAttempt: number;
    }>([
      {
        label: "in the effective attempt",
        attempts: [ghostAttempt],
        effectiveRunAttempt: 2,
        plannedRunAttempt: 2,
      },
      {
        label: "without a completed sibling",
        attempts: [
          { jobs: [ghost, ghost], runAttempt: 1 },
          { jobs: [job("test", "success")], runAttempt: 2 },
        ],
        effectiveRunAttempt: 2,
        plannedRunAttempt: 1,
      },
      {
        label: "once the copy has a runner",
        attempts: [
          { jobs: [{ ...ghost, runner_name: "GitHub Actions 2" }, completed], runAttempt: 1 },
          { jobs: [job("test", "success")], runAttempt: 2 },
        ],
        effectiveRunAttempt: 2,
        plannedRunAttempt: 1,
      },
    ])(
      "still rejects duplicates $label",
      ({ attempts, effectiveRunAttempt, plannedRunAttempt }) => {
        expect(() =>
          composeReleaseAttemptJobs(attempts, { effectiveRunAttempt, plannedRunAttempt }),
        ).toThrow("duplicate job identity");
      },
    );
  });

  it("rejects duplicate logical jobs and gapped attempts", () => {
    expect(() =>
      composeReleaseAttemptJobs(
        [{ jobs: [job("test", "failure"), job("test", "success")], runAttempt: 1 }],
        { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
      ),
    ).toThrow("duplicate job identity");
    expect(() =>
      composeReleaseAttemptJobs(
        [
          { jobs: [job("test", "failure")], runAttempt: 1 },
          { jobs: [job("test", "success")], runAttempt: 3 },
        ],
        { effectiveRunAttempt: 3, plannedRunAttempt: 1 },
      ),
    ).toThrow("gapped");
  });
});

describe("release decision policy", () => {
  const windowsJob = {
    name: "checks-windows-node-test-2",
    conclusion: "failure",
    status: "completed",
    url: "https://example.invalid/windows",
  };
  const ciGate = { name: "openclaw/ci-gate", conclusion: "success", status: "completed" };

  // In-process readChild calls compose child provenance expectations from the ambient
  // process.env.GITHUB_REPOSITORY, while every GitHub run fixture in this suite describes
  // the canonical openclaw/openclaw repository. Fork checkouts run these tests with their
  // own GITHUB_REPOSITORY and would fail provenance validation, so pin the ambient
  // repository to the fixture identity for this suite and restore it afterwards. The
  // collector subprocess tests already pin the same identity via collectorEnv().
  let ambientRepository: string | undefined;
  beforeEach(() => {
    ambientRepository = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = "openclaw/openclaw";
  });
  afterEach(() => {
    if (ambientRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = ambientRepository;
    }
  });

  it.each(["beta", "stable"])(
    "blocks %s release decisions and evidence on a failed Windows Node shard",
    (releaseProfile) => {
      const snapshot = child("normalCi", {
        conclusion: "failure",
        jobs: [windowsJob, ciGate],
        status: "completed",
      });
      const result = classifyReleaseSnapshot({ children: [snapshot], releaseProfile });
      expect(result).toMatchObject({
        blockers: [
          {
            child: "normalCi",
            job: windowsJob.name,
            conclusion: "failure",
            runId: snapshot.runId,
            url: windowsJob.url,
          },
        ],
        blockerCount: 1,
        errors: [],
        state: "blocked_complete",
        advisoryJobs: [],
      });
      expect(terminalPolicyPass(snapshot)).toBe(false);
      const artifact = buildReleaseStateArtifact({
        children: [snapshot],
        decision: result,
        executionPlan: { parentRunAttempt: 1, sha256: "a".repeat(64) },
        expected: { parentRunAttempt: 1, parentRunId: "77", targetSha: TARGET_SHA },
        mode: "decision",
        releaseProfile,
        rerunGroup: "all",
      });
      expect(validateReleaseStateArtifact(artifact).advisoryJobs).toEqual(result.advisoryJobs);
      expect(formatReleaseStateOutcome(artifact)).toContain(
        "- Blocker: checks-windows-node-test-2 (failure) https://example.invalid/windows",
      );
      const manifest = buildReleaseValidationManifest({
        plan: executionPlan(),
        drain: artifact,
        context: { releaseProfile, rerunGroup: "all", validationInputs: {} },
      });
      expect(manifest.version).toBe(4);
      expect(manifest.advisoryJobs).toEqual(result.advisoryJobs);
    },
  );

  it("accepts a human child rerun with retained earlier jobs in a reused plan", async () => {
    const original = child("normalCi");
    const planned = hydrateReusedPlan([original], {
      children: [
        {
          ...reusedEvidenceChildren()[0],
          displayTitle: original.displayTitle,
          runAttempt: 2,
        },
      ],
      manifest: { childEvidence: { normalCi: { plannedRunAttempt: 1 } } },
    })[0];
    assert(planned, "selected child remains present in the reused plan");
    const result = await readChild(planned, undefined, undefined, {
      readRun: async () =>
        githubRun(original, {
          conclusion: "success",
          html_url: original.url,
          path: ".github/workflows/ci.yml@refs/heads/release-ci/tooling",
          run_attempt: 2,
          triggering_actor: { login: "release-operator" },
        }),
      readAttemptJobs: async (_runId, attempt) =>
        attempt === 1
          ? [
              { name: "lint", status: "completed", conclusion: "success" },
              { name: "test", status: "completed", conclusion: "failure" },
            ]
          : [{ name: "test", status: "completed", conclusion: "success" }],
    });
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({
      observedRunAttempts: [1, 2],
      plannedRunAttempt: 1,
      runAttempt: 2,
      triggeringActor: "release-operator",
    });
    expect(result.jobs).toEqual([
      expect.objectContaining({ name: "lint", acceptedRunAttempt: 1, conclusion: "success" }),
      expect.objectContaining({ name: "test", acceptedRunAttempt: 2, conclusion: "success" }),
    ]);
  });

  it("preserves the last valid snapshot through a transient error and then recovers", async () => {
    const message = "HTTP 403: secondary rate limit";
    const planned = child("normalCi");
    const previous = {
      ...planned,
      conclusion: "success",
      jobs: [{ conclusion: "success", name: "test", status: "completed" }],
      status: "completed",
    };
    let fail = true;
    const readRun = async () => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error(message), {
          stderr: message,
        });
      }
      return githubRun(planned, {
        conclusion: "success",
        created_at: "2026-08-21T00:00:00Z",
        html_url: planned.url,
        updated_at: "2026-08-21T00:01:00Z",
      });
    };
    const readAttemptJobs = async () => [
      {
        completed_at: "2026-08-21T00:01:00Z",
        conclusion: "success",
        html_url: "https://example.invalid/jobs/test",
        name: "test",
        started_at: "2026-08-21T00:00:00Z",
        status: "completed",
      },
    ];

    const degraded = await readChild(planned, previous, undefined, {
      readAttemptJobs,
      readRun,
    });
    expect(degraded).toMatchObject({
      conclusion: "success",
      errors: [],
      jobs: previous.jobs,
      status: "transport_uncertain",
    });
    expect(
      classifyReleaseSnapshot({
        children: [degraded],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ errors: [], state: "qualifying" });

    const recovered = await readChild(planned, degraded, undefined, {
      readAttemptJobs,
      readRun,
    });
    expect(recovered).toMatchObject({
      conclusion: "success",
      errors: [],
      status: "completed",
    });
    expect(
      classifyReleaseSnapshot({
        children: [recovered],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ errors: [], state: "passed" });
  });

  it("fails child provenance mismatches without consuming preserved success", async () => {
    const planned = child("normalCi");
    const observed = await readChild(
      planned,
      { ...planned, conclusion: "success", status: "completed" },
      undefined,
      {
        readAttemptJobs: async () => [],
        readRun: async () =>
          githubRun(planned, {
            conclusion: "success",
            head_sha: "c".repeat(40),
          }),
      },
    );
    expect(observed.errors).toEqual([expect.objectContaining({ kind: "provenance_mismatch" })]);
    expect(
      classifyReleaseSnapshot({
        children: [observed],
        releaseProfile: "stable",
        workflowRef: "main",
      }),
    ).toMatchObject({ state: "orchestration_error" });
  });

  it("preserves complete composite evidence when the run read succeeds but jobs fail", async () => {
    const planned = child("normalCi");
    const previous = {
      ...planned,
      compositeJobsSha256: "f".repeat(64),
      conclusion: "success",
      jobs: [{ conclusion: "success", name: "test", status: "completed" }],
      observedRunAttempts: [1],
      plannedRunAttempt: 1,
      status: "completed",
      transportFailure: { errorClass: "transient" },
    };
    const observed = await readChild(planned, previous, undefined, {
      readAttemptJobs: async (_runId, attempt) => {
        if (attempt === 2) {
          throw Object.assign(new Error("HTTP 503: Server Error"), {
            stderr: "HTTP 503: Server Error",
          });
        }
        return previous.jobs;
      },
      readRun: async () =>
        githubRun(planned, {
          conclusion: "",
          run_attempt: 2,
          status: "in_progress",
        }),
    });
    expect(observed).toMatchObject({
      compositeJobsSha256: previous.compositeJobsSha256,
      jobs: previous.jobs,
      runAttempt: 1,
      status: "transport_uncertain",
      transportFailure: { errorClass: "transient" },
    });
    expect(
      await readChild(
        planned,
        {
          ...planned,
          status: "transport_uncertain",
          transportFailure: { errorClass: "transient" },
        },
        undefined,
        {
          readAttemptJobs: async () => [],
          readRun: async () => githubRun(planned, { status: "in_progress" }),
        },
      ),
    ).toMatchObject({
      status: "in_progress",
      transportFailure: { errorClass: "transient" },
    });
  });

  it("uses one fixed monotonic transport deadline until recovery", () => {
    const uncertainChild = {
      ...child("normalCi"),
      transportFailure: { errorClass: "transient" },
    };
    const first = updateReleaseTransportEpisode(undefined, [uncertainChild], {
      deadline: 900_000,
      monotonicNow: 100,
      wallNow: Date.parse("2026-08-29T00:00:00.100Z"),
    });
    const repeated = updateReleaseTransportEpisode(first, [uncertainChild], {
      monotonicNow: 899_999,
      wallNow: Date.parse("2026-08-29T01:00:00Z"),
    });
    const expired = updateReleaseTransportEpisode(first, [uncertainChild], {
      monotonicNow: 900_100,
      wallNow: Date.parse("2026-08-29T02:00:00Z"),
    });
    expect(repeated).toMatchObject({
      deadlineAt: first.deadlineAt,
      startedAt: "2026-08-29T00:00:00.000Z",
      status: "uncertain",
    });
    expect(expired).toMatchObject({
      deadlineAt: first.deadlineAt,
      error: { kind: "transport_deadline_exceeded" },
      status: "expired",
    });
    expect(
      updateReleaseTransportEpisode(first, [{ ...uncertainChild, transportFailure: undefined }]),
    ).toEqual({ status: "certain" });
  });

  it("caps GitHub retry sleep at the remaining transport deadline", () => {
    expect(releaseGhRetryDelayMs(6, 105_000, 100_000)).toBe(5_000);
    expect(releaseGhRetryDelayMs(6, 100_000, 100_000)).toBe(0);
  });
});

describe("release state artifacts", () => {
  const FAILED_JOB = {
    conclusion: "failure",
    name: "upgrade-survivor",
    status: "completed",
    url: "https://example.invalid/jobs/test",
  };

  function stateArtifact(
    mode: "decision" | "drain",
    state: string,
    sealedPlan = executionPlan({ rerunGroup: "ci" }),
  ) {
    const active = { conclusion: "", status: "in_progress" };
    if (state === "qualifying") {
      return collectorArtifact(mode, 2, sealedPlan, active);
    }
    if (state === "blocked_complete") {
      return collectorArtifact(mode, 2, sealedPlan, { conclusion: "failure", jobs: [FAILED_JOB] });
    }
    if (state === "cancelled_with_children") {
      return collectorArtifact(mode, 2, sealedPlan, active, {
        cancellation: { cancelledRunIds: [], requested: true },
        extraErrors: [
          {
            child: "<collector>",
            kind: "collector_cancelled",
            message: `${mode} collector received a termination signal`,
          },
        ],
      });
    }
    return collectorArtifact(mode, 2, sealedPlan);
  }

  function blockedArtifacts(sealedPlan = executionPlan({ rerunGroup: "ci" })) {
    return {
      decision: collectorArtifact("decision", 2, sealedPlan, {
        conclusion: "",
        jobs: [FAILED_JOB],
        status: "in_progress",
      }),
      drain: collectorArtifact("drain", 2, sealedPlan, {
        conclusion: "failure",
        jobs: [FAILED_JOB],
      }),
      sealedPlan,
    };
  }

  function attemptedBlockedArtifact(
    mode: "decision" | "drain",
    sealedPlan: ReturnType<typeof executionPlan>,
    attempts: { runAttempt: number; jobs: Record<string, unknown>[] }[],
  ) {
    const runAttempt = attempts.at(-1)!.runAttempt;
    const composite = composeReleaseAttemptJobs(attempts, {
      plannedRunAttempt: 1,
      effectiveRunAttempt: runAttempt,
    });
    return collectorArtifact(mode, 2, sealedPlan, {
      compositeJobsSha256: composite.sha256,
      conclusion: "failure",
      status: mode === "decision" ? "in_progress" : "completed",
      dispatchActor: "github-actions[bot]",
      jobs: composite.jobs,
      observedRunAttempts: attempts.map((attempt) => attempt.runAttempt),
      plannedRunAttempt: 1,
      repository: "openclaw/openclaw",
      runAttempt,
      triggeringActor: "release-operator",
    });
  }

  function stateExpected(maxParentRunAttempt = 2) {
    return {
      maxParentRunAttempt,
      parentRunId: "77",
      releaseProfile: "stable",
      rerunGroup: "ci",
      targetSha: TARGET_SHA,
      workflowRef: "release-ci/tooling",
      workflowSha: SHA,
    };
  }

  function compositeArtifact(status = "completed"): Record<string, any> {
    const composite = composeReleaseAttemptJobs(
      [
        {
          jobs: ["qa smoke ci", "QA Smoke CI"].map((name) => ({
            conclusion: "success",
            name,
            status: "completed",
          })),
          runAttempt: 1,
        },
      ],
      { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
    );
    return collectorArtifact("decision", 2, executionPlan({ rerunGroup: "ci" }), {
      compositeJobsSha256: composite.sha256,
      conclusion: status === "completed" ? "success" : "",
      dispatchActor: "github-actions[bot]",
      jobs: composite.jobs,
      observedRunAttempts: [1],
      plannedRunAttempt: 1,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      status,
      triggeringActor: "github-actions[bot]",
    });
  }

  function selectPair(
    sealedPlan: Record<string, any>,
    decision: Record<string, any>,
    drain: Record<string, any>,
  ) {
    return selectReleaseStateArtifacts(
      sealedPlan,
      [{ name: "full-release-decision-77-2", payload: decision }],
      [{ name: "full-release-diagnostics-77-2", payload: drain }],
      stateExpected(),
    );
  }

  it("uses one policy for decision, drain, and final verification", () => {
    expect(
      verifyReleaseStateArtifacts(
        executionPlan({ rerunGroup: "ci" }),
        collectorArtifact("decision"),
        collectorArtifact("drain"),
        { ...stateExpected(), parentRunAttempt: 2 },
      ),
    ).toMatchObject({ decision: { state: "passed" }, drain: { state: "passed" } });
    const decision = { ...collectorArtifact("decision"), automaticRetries: [] };
    const drain = { ...collectorArtifact("drain"), automaticRetries: [] };
    expect(
      verifyReleaseStateArtifacts(
        executionPlan({ rerunGroup: "ci" }),
        decision,
        drain,
        stateExpected(),
      ),
    ).toMatchObject({ decision: { automaticRetries: [] }, drain: { automaticRetries: [] } });
    expect(() =>
      validateReleaseStateArtifact({ ...decision, automaticRetries: [{ outcome: "observed" }] }),
    ).toThrow("automaticRetries must be empty");
  });

  it("records a blocker while transport is simultaneously uncertain", () => {
    const transport = updateReleaseTransportEpisode(undefined, [
      {
        ...child("normalCi"),
        transportFailure: { errorClass: "transient" },
      },
    ]);
    const payload = collectorArtifact(
      "decision",
      2,
      executionPlan({ rerunGroup: "ci" }),
      { conclusion: "", jobs: [FAILED_JOB], status: "in_progress" },
      { transport },
    );
    expect(payload).toMatchObject({
      blockerCount: 1,
      state: "blocked_diagnostics_running",
      transport: { status: "uncertain" },
    });
  });

  it("records expired transport without serializing collector internals", () => {
    const transport = updateReleaseTransportEpisode(
      undefined,
      [{ ...child("normalCi"), transportFailure: { errorClass: "transient" } }],
      {
        deadline: 900_000,
        monotonicNow: 0,
        wallNow: Date.parse("2026-08-29T00:00:00Z"),
      },
    );
    const expired = updateReleaseTransportEpisode(
      transport,
      [{ ...child("normalCi"), transportFailure: { errorClass: "transient" } }],
      { monotonicNow: 900_000, wallNow: Date.parse("2026-08-29T00:15:00Z") },
    );
    const payload = collectorArtifact(
      "decision",
      2,
      executionPlan({ rerunGroup: "ci" }),
      {},
      {
        extraErrors: [expired.error],
        transport: expired,
      },
    );
    expect(payload.errors).toContainEqual(
      expect.objectContaining({ kind: "transport_deadline_exceeded" }),
    );
    expect(payload.transport).not.toHaveProperty("deadlineMonotonicMs");
    expect(payload.transport).not.toHaveProperty("error");
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).not.toThrow();
  });

  it("keeps a maximal paginated retry blocker index within the artifact budget", () => {
    const attempts = Array.from({ length: 5 }, (_unused, attempt) => ({
      jobs: Array.from({ length: 100 }, (_, offset) => {
        const index = attempt * 100 + offset;
        return {
          ...FAILED_JOB,
          completed_at: "2026-08-29T00:00:00Z",
          name: `install_smoke-failed-${String(index).padStart(3, "0")}`,
          url: `https://example.invalid/jobs/${"x".repeat(960)}-${index}`,
        };
      }),
      runAttempt: attempt + 1,
    }));
    const composite = composeReleaseAttemptJobs(attempts, {
      effectiveRunAttempt: 5,
      plannedRunAttempt: 1,
    });
    const payload = collectorArtifact("decision", 2, executionPlan({ rerunGroup: "ci" }), {
      compositeJobsSha256: composite.sha256,
      conclusion: "failure",
      jobs: composite.jobs,
      observedRunAttempts: attempts.map(({ runAttempt }) => runAttempt),
      plannedRunAttempt: 1,
      runAttempt: 5,
    });
    const bytes = Buffer.byteLength(serializeReleaseArtifact(payload), "utf8");
    expect(payload.blockerIndex).toHaveLength(500);
    expect(payload.blockers).toHaveLength(25);
    expect(payload.firstPrimaryFailure).toMatchObject({
      job: "install_smoke-failed-000",
      kind: "job_failure",
    });
    expect(validateReleaseStateArtifact(payload, stateExpected(), "decision")).toMatchObject({
      blockerCount: 500,
    });
    expect(bytes).toBeLessThanOrEqual(MAX_RELEASE_ARTIFACT_BYTES);
  });

  it("reads legacy v2 evidence without claiming blocked-list completeness", () => {
    const passed = structuredClone(collectorArtifact("decision"));
    const blocked = structuredClone(stateArtifact("decision", "blocked_complete"));
    for (const payload of [passed, blocked]) {
      delete payload.blockerCount;
      delete payload.blockerIndex;
      delete payload.firstPrimaryFailure;
      delete payload.transport;
    }
    expect(validateReleaseStateArtifact(passed, stateExpected(), "decision")).toMatchObject({
      blockerCount: null,
      transport: { status: "certain" },
    });
    expect(validateReleaseStateArtifact(blocked, stateExpected(), "decision")).toMatchObject({
      blockerCount: null,
      state: "blocked_complete",
      transport: null,
    });
  });

  it("rejects malformed complete blocker evidence", () => {
    const payload = structuredClone(stateArtifact("decision", "blocked_complete"));
    payload.blockerCount = Number(payload.blockerCount) + 1;
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).toThrow(
      "release state machine evidence is invalid",
    );
  });

  it("rejects noncanonical composite job ordering", () => {
    const payload = compositeArtifact();
    payload.children.normalCi.timing.jobs.reverse();
    expect(() => validateReleaseStateArtifact(payload, stateExpected(), "decision")).toThrow(
      "release state child composite jobs are invalid: normalCi",
    );
  });

  it("accepts a queued run snapshot after its jobs have progressed", () => {
    expect(
      validateReleaseStateArtifact(compositeArtifact("queued"), stateExpected(), "decision"),
    ).toMatchObject({
      activeRunIds: ["101"],
      children: {
        normalCi: {
          status: "queued",
          timing: {
            jobs: [
              { name: "QA Smoke CI", status: "completed" },
              { name: "qa smoke ci", status: "completed" },
            ],
          },
        },
      },
      state: "qualifying",
    });
  });

  it("requires Decision and Drain to carry identical accepted attempt evidence", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = collectorArtifact("decision", 2, sealedPlan);
    const drain = structuredClone(collectorArtifact("drain", 2, sealedPlan));
    const snapshot = drain.children.normalCi!;
    snapshot.runAttempt = 2;
    expect(() =>
      verifyReleaseStateArtifacts(sealedPlan, decision, drain, {
        maxParentRunAttempt: 2,
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      }),
    ).toThrow("release decision and diagnostic drain child evidence differ");
  });

  it.each([
    [
      "malformed active run IDs",
      (value: Record<string, any>) => (value.activeRunIds = ["", "101"]),
    ],
    [
      "duplicate observed attempts",
      (value: Record<string, any>) => (value.children.normalCi.observedRunAttempts = [1, 1]),
    ],
  ])("rejects $0 without filtering or cleanup", (_name, mutate) => {
    const payload = structuredClone(collectorArtifact("decision"));
    mutate(payload);
    expect(() =>
      validateReleaseStateArtifact(payload, {
        parentRunAttempt: 2,
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      }),
    ).toThrow(/invalid|gapped|malformed/u);
  });

  it("rejects asymmetric retries that retain a blocked drain", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const initialChild = { conclusion: "failure", jobs: [FAILED_JOB] };
    const select = () =>
      selectReleaseStateArtifacts(
        sealedPlan,
        [
          {
            name: "full-release-decision-77-1",
            payload: collectorArtifact("decision", 1, sealedPlan, initialChild),
          },
          {
            name: "full-release-decision-77-2",
            payload: collectorArtifact("decision", 2, sealedPlan),
          },
        ],
        [
          {
            name: "full-release-diagnostics-77-1",
            payload: collectorArtifact("drain", 1, sealedPlan, initialChild),
          },
        ],
        stateExpected(3),
      );
    expect(select).toThrow("release decision and diagnostic drain transition is invalid");
    expect(select).toThrow(
      "release decision and diagnostic drain transition is invalid: " +
        "decision(parentRunAttempt=2, state=passed), " +
        "drain(parentRunAttempt=1, state=blocked_complete); " +
        `executionPlan(originalParentRunAttempt=1, sha256=${sealedPlan.sha256}); ` +
        "compatible collector evidence for the same execution plan is required",
    );
  });

  it("retains a failed logical job when a later attempt replaces its job URL", () => {
    const sealedPlan = executionPlan(
      { rerunGroup: "ci" },
      { attemptEvidenceVersion: 2, candidateRequest: candidateBinding().request },
    );
    const retriedJob = { ...FAILED_JOB, url: "https://example.invalid/jobs/retried" };
    const attempts = [
      { runAttempt: 1, jobs: [FAILED_JOB] },
      { runAttempt: 2, jobs: [retriedJob] },
    ];
    const decision = attemptedBlockedArtifact("decision", sealedPlan, attempts.slice(0, 1));
    const drain = attemptedBlockedArtifact("drain", sealedPlan, attempts);
    expect(selectPair(sealedPlan, decision, drain)).toMatchObject({
      decision: { state: "blocked_diagnostics_running" },
      drain: {
        state: "blocked_complete",
        blockers: [{ job: "upgrade-survivor", url: retriedJob.url }],
      },
    });
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "Full Release Validation state: blocked_complete\n- Blocker: upgrade-survivor (failure)",
    );
  });

  it.each([
    "same accepted attempt",
    "blocker URL outside its job evidence",
    "foreign-run blocker borrowing child job evidence",
    "historical plan without attempt validation",
    "renamed job",
  ])("rejects replacement blocker URLs with %s", (scenario) => {
    const sealedPlan = executionPlan(
      { rerunGroup: "ci" },
      scenario === "historical plan without attempt validation"
        ? {}
        : { attemptEvidenceVersion: 2, candidateRequest: candidateBinding().request },
    );
    const first = { runAttempt: 1, jobs: [FAILED_JOB] };
    const replaced = {
      ...FAILED_JOB,
      url: "https://example.invalid/jobs/retried",
      ...(scenario === "renamed job" ? { name: "different upgrade-survivor" } : {}),
    };
    const second = {
      runAttempt: 2,
      jobs:
        scenario === "renamed job"
          ? [{ ...FAILED_JOB, conclusion: "success" }, replaced]
          : [replaced],
    };
    const decision = attemptedBlockedArtifact("decision", sealedPlan, [first]);
    const drain = attemptedBlockedArtifact(
      "drain",
      sealedPlan,
      scenario === "same accepted attempt"
        ? [{ runAttempt: 1, jobs: [replaced] }]
        : [first, second],
    );
    if (scenario === "blocker URL outside its job evidence") {
      drain.blockers = drain.blockers.map((blocker) => ({
        ...blocker,
        url: "https://example.invalid/jobs/unrelated",
      }));
    }
    if (scenario === "foreign-run blocker borrowing child job evidence") {
      for (const snapshot of [decision, drain]) {
        snapshot.blockers.push({ ...snapshot.blockers[0], runId: "999" });
      }
    }
    expect(() => selectPair(sealedPlan, decision, drain)).toThrow("changed or removed");
  });

  it("selects a terminal blocked pair when workflow evidence refines to failed jobs", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = collectorArtifact("decision", 2, sealedPlan, {
      conclusion: "failure",
      jobs: [],
    });
    const drain = stateArtifact("drain", "blocked_complete", sealedPlan);
    expect(selectPair(sealedPlan, decision, drain).drain.blockers).toContainEqual(
      expect.objectContaining({ job: "upgrade-survivor", kind: "job_failure" }),
    );
  });

  it("selects a cancellation request that races with child completion", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = collectorArtifact(
      "decision",
      2,
      sealedPlan,
      {},
      {
        cancellation: { requested: true },
        extraErrors: [
          {
            child: "<collector>",
            kind: "collector_cancelled",
            message: "decision collector received a termination signal",
          },
        ],
      },
    );
    const drain = stateArtifact("drain", "passed", sealedPlan);
    expect(selectPair(sealedPlan, decision, drain).decision.state).toBe("orchestration_error");
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "Full Release Validation state: orchestration_error",
    );
  });

  it("rejects a forged passed state with an unproven cancellation request", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = collectorArtifact("decision", 2, sealedPlan);
    const drain = collectorArtifact("drain", 2, sealedPlan);
    decision.cancellation = { cancelledRunIds: [], requested: true };
    expect(() => selectPair(sealedPlan, decision, drain)).toThrow("cancellation differs");
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "cancellation differs",
    );
  });

  it("selects active reused_evidence_invalid recovery without authorizing publication", () => {
    const kind = "reused_evidence_invalid";
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = collectorArtifact(
      "decision",
      2,
      sealedPlan,
      { conclusion: "", status: "in_progress" },
      { extraBlockers: [{ child: "<evidence>", kind, message: "evidence failed" }] },
    );
    const drain = stateArtifact("drain", "passed", sealedPlan);
    expect(selectPair(sealedPlan, decision, drain).decision.state).toBe(
      "blocked_diagnostics_running",
    );
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      "Full Release Validation state: blocked_diagnostics_running\n- Blocker: evidence failed",
    );
  });

  it("does not authorize selected signal cancellation evidence", () => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    expect(() =>
      verifyReleaseStateArtifacts(
        sealedPlan,
        stateArtifact("decision", "cancelled_with_children", sealedPlan),
        stateArtifact("drain", "passed", sealedPlan),
        stateExpected(),
      ),
    ).toThrow("Full Release Validation state: cancelled_with_children");
  });

  it.each([
    {
      name: "child provenance drift",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain.children.normalCi!.displayTitle = "nearby title";
      },
      reason: "provenance differs",
    },
    {
      name: "falsely classified drain",
      mutate: (pair: ReturnType<typeof blockedArtifacts>) => {
        pair.drain.state = "passed";
      },
      reason: "differs from canonical release policy",
    },
  ])("rejects a blocked transition with $name", ({ mutate, reason }) => {
    const pair = blockedArtifacts();
    mutate(pair);
    const { decision, drain, sealedPlan } = pair;
    expect(() => selectPair(sealedPlan, decision, drain)).toThrow(reason);
  });

  it.each([
    {
      name: "unplanned signal cancellation ID",
      cancelledRunIds: ["999"],
      state: "cancelled_with_children",
    },
    {
      name: "fail-fast cancellation without a blocker",
      cancelledRunIds: ["101"],
      state: "qualifying",
    },
  ])("rejects $name", ({ cancelledRunIds, state }) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = stateArtifact("decision", state, sealedPlan);
    decision.cancellation = {
      cancelledRunIds,
      requested: state === "cancelled_with_children",
    };
    expect(() =>
      selectPair(sealedPlan, decision, stateArtifact("drain", "passed", sealedPlan)),
    ).toThrow("cancellation differs");
  });

  it.each(["direct", "nested", "asymmetric"] as const)(
    "selects downloaded state artifacts from the %s layout",
    (layout) => {
      const root = tempDirs.make("frv-select-");
      const executionPlanPath = join(root, "plan.json");
      const outputPath = join(root, "output.txt");
      const sealedPlan = executionPlan({ rerunGroup: "ci" });
      writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
      const env: NodeJS.ProcessEnv = {
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: "3",
        RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      };
      for (const [mode, prefix, filename, envPrefix] of [
        ["decision", "full-release-decision", "full-release-decision.json", "RELEASE_DECISION"],
        [
          "drain",
          "full-release-diagnostics",
          "full-release-diagnostic-manifest.json",
          "DIAGNOSTIC_DRAIN",
        ],
      ] as const) {
        const candidatesRoot = join(root, mode);
        const attempts =
          layout === "direct" ? [2] : layout === "asymmetric" && mode === "drain" ? [1] : [1, 2];
        for (const attempt of attempts) {
          const directory =
            layout === "direct" ? candidatesRoot : join(candidatesRoot, `${prefix}-77-${attempt}`);
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, filename),
            JSON.stringify(collectorArtifact(mode, attempt, sealedPlan)),
          );
        }
        env[`${envPrefix}_ATTEMPTS_PATH`] = candidatesRoot;
        env[`${envPrefix}_PATH`] = join(root, `selected-${mode}.json`);
      }
      const result = runCollector("select", env);
      expect(result.status, result.stderr).toBe(0);
      const output = readFileSync(outputPath, "utf8");
      for (const [mode, attempt] of [
        ["decision", 2],
        ["drain", layout === "asymmetric" ? 1 : 2],
      ] as const) {
        expect(output).toContain(`${mode}_source_attempt=${attempt}\n`);
        expect(JSON.parse(readFileSync(join(root, `selected-${mode}.json`), "utf8"))).toMatchObject(
          { parentRunAttempt: attempt, state: "passed" },
        );
      }
    },
  );

  it.each([
    {
      mutate: (drain: Record<string, any>) => {
        drain.children.normalCi.conclusion = "failure";
      },
      name: "failed child hidden behind passed state",
      reason: "omits baseline blockers",
    },
  ])("rejects a malformed passed drain with $name", ({ mutate, reason }) => {
    const sealedPlan = executionPlan({ rerunGroup: "ci" });
    const decision = collectorArtifact("decision", 2, sealedPlan);
    const drain = structuredClone(collectorArtifact("drain", 2, sealedPlan));
    mutate(drain);
    expect(() => verifyReleaseStateArtifacts(sealedPlan, decision, drain, stateExpected())).toThrow(
      reason,
    );
  });
});

describe("collector subprocess", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts.close();
  });

  function collectorClosed(childProcess: ReturnType<typeof spawn>) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (complete, reject) => {
        childProcess.once("error", reject);
        childProcess.once("close", (code, signal) => complete({ code, signal }));
      },
    );
  }

  async function fixtureReadyBeforeSettlement(readyPath: string, operation: Promise<unknown>) {
    // The readiness receipt and collector exit are unordered; the fixture writes this
    // record before replying, so an exit that wins the race still sees readiness.
    await Promise.race([
      receipts.waitFor(readyPath, "ready"),
      operation.then(() => {
        if (!existsSync(readyPath)) {
          throw new Error(`timeout waiting for ${readyPath}`);
        }
      }),
    ]);
  }

  async function stopCollector(childProcess: ReturnType<typeof spawn>, closed: Promise<unknown>) {
    // Plan cancellation kills its validator, which can leave fake-gh behind. The
    // test's private process group owns that fixture even after the collector exits.
    try {
      if (process.platform !== "win32" && childProcess.pid) {
        process.kill(-childProcess.pid, "SIGKILL");
      } else {
        childProcess.kill("SIGKILL");
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
    }
    await closed;
  }

  it("releases polling sleep listeners before the next GitHub observation", () => {
    const root = tempDirs.make("frv-state-sleep-listeners-");
    const executionPlanPath = join(root, "plan.json");
    const output = join(root, "decision.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan({
          children: { normalCi: { result: "success", runAttempt: 1, runId: "101" } },
          dockerPreflightResult: "skipped",
          candidateBindingResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
        }),
      ),
    );
    const controller = join(root, "controller.mjs");
    writeFileSync(
      controller,
      `import assert from "node:assert/strict";
import cp from "node:child_process";
import { getEventListeners } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { promisify } from "node:util";
let observations = 0;
let retainedListeners = 0;
cp.execFile = Object.assign(() => { throw new Error("unexpected callback execution"); }, {
  [promisify.custom]: async (command, args, options) => {
    assert.equal(command, "gh");
    retainedListeners = Math.max(retainedListeners, getEventListeners(options.signal, "abort").length);
    if (args.includes("--paginate")) {
      setImmediate(() => mock.timers.tick(60_000));
      return { stdout: "" };
    }
    if (++observations === 12) {
      throw Object.assign(new Error("HTTP 403: Resource not accessible by integration"), {
        stderr: "HTTP 403: Resource not accessible by integration",
      });
    }
    return { stdout: JSON.stringify({
      id: 101, event: "workflow_dispatch", path: ".github/workflows/ci.yml@refs/heads/release-ci/tooling",
      display_title: "CI full-release-validation-77-1-ci", head_branch: "release-ci/tooling",
      head_sha: ${JSON.stringify(SHA)}, run_attempt: 1, status: "in_progress", conclusion: null,
      created_at: "2026-08-21T00:00:00Z", updated_at: "2026-08-21T00:01:00Z",
      html_url: "https://example.invalid/runs/101", actor: { login: "github-actions[bot]" },
      triggering_actor: { login: "github-actions[bot]" }, repository: { full_name: "openclaw/openclaw" },
    }) };
  },
});
syncBuiltinESMExports();
mock.timers.enable({ apis: ["setTimeout"] });
process.argv[1] = ${JSON.stringify(SCRIPT)};
process.argv[2] = "decision";
try {
  await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
  assert.equal(observations, 12);
  assert.equal(retainedListeners, 0, "completed polling sleeps retained abort listeners");
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
} finally {
  mock.timers.reset();
}
`,
    );
    const result = spawnSync(process.execPath, [controller], {
      encoding: "utf8",
      env: collectorEnv({
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_STATE_PATH: output,
        FAIL_FAST: "false",
      }),
      timeout: 10_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).state).toBe("orchestration_error");
  });

  it.each([
    {
      changedPaths: ["CHANGELOG.md"],
      evidenceSha: "c".repeat(40),
      name: "changelog-only",
      policy: "changelog-only-release-v1",
      trustedWorkflow: {
        fullRef: `refs/tags/release-publish/${SHA.slice(0, 12)}-123`,
        ref: `release-publish/${SHA.slice(0, 12)}-123`,
        sha: SHA,
      },
    },
    ...["exact-source", "wrong-purpose"].map((name) => ({
      changedPaths: [],
      evidenceSha: TARGET_SHA,
      name,
      policy: "exact-target-full-validation-v1",
      trustedWorkflow: TRUSTED_MAIN,
      source: true,
    })),
  ])("seals and revalidates the complete $name reuse tuple", (reuse) => {
    const root = tempDirs.make("frv-plan-reuse-");
    const output = join(root, "full-release-execution-plan.json");
    const validator = join(root, "release-evidence-validator.mjs");
    const validatorArgs = join(root, "validator-args.json");
    writeFileSync(
      validator,
      `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FRV_VALIDATOR_ARGS, JSON.stringify(args));
const value = (flag) => args[args.indexOf(flag) + 1];
const expected = JSON.parse(process.env.FRV_EXPECTED_REUSE);
for (const [flag, wanted] of Object.entries(expected)) {
  if (value(flag) !== wanted) {
    console.error(\`\${flag} mismatch: \${value(flag)} != \${wanted}\`);
    process.exit(1);
  }
}
console.log(JSON.stringify({
  children: JSON.parse(process.env.FRV_REUSED_CHILDREN),
  manifest: JSON.parse(process.env.FRV_EVIDENCE_MANIFEST),
  releaseProfile: process.env.RELEASE_PROFILE,
  rerunGroup: process.env.RERUN_GROUP,
}));
`,
    );
    const sourceAdmission = "source" in reuse ? sourceFact() : undefined;
    const rootSource = sourceAdmission
      ? sourceFact({
          runId: "99",
          candidateSha: reuse.evidenceSha,
          ...(reuse.name === "wrong-purpose"
            ? { validationPurpose: "diagnostic", publicationSelection: null }
            : {}),
        })
      : undefined;
    const sourceManifest = rootSource
      ? {
          ...evidenceManifest(),
          targetSha: reuse.evidenceSha,
          sourceAdmissionContract: "1",
          sourceAdmission: rootSource,
          trustedWorkflow: TRUSTED_MAIN,
          validationInputs: {
            ...publicationIntentInputs(rootSource),
            targetContextRef: "release/2026.9.9",
            allowUnreleasedChangelog: "false",
          },
        }
      : evidenceManifest();
    const planInputs = planInput({
      ...(sourceAdmission ? { sourceAdmissionContract: "1", sourceAdmission } : {}),
      dockerPreflightResult: "skipped",
      evidenceChangedPaths: reuse.changedPaths,
      evidenceManifest: { attackerControlled: true },
      evidencePolicy: reuse.policy,
      evidenceReuse: true,
      evidenceRootRunId: "99",
      evidenceRunId: "99",
      evidenceRunUrl: "https://example.invalid/runs/99",
      evidenceSha: reuse.evidenceSha,
      trustedWorkflow: reuse.trustedWorkflow,
    });
    const result = runCollector("plan", {
      FRV_EXPECTED_REUSE: JSON.stringify({
        "--expected-changed-paths-json": JSON.stringify(reuse.changedPaths),
        "--expected-evidence-policy": reuse.policy,
        "--expected-evidence-sha": reuse.evidenceSha,
        "--expected-root-run-id": "99",
        "--expected-selected-run-id": "99",
        "--expected-target-sha": TARGET_SHA,
        "--trusted-workflow-full-ref": reuse.trustedWorkflow.fullRef,
        "--trusted-workflow-ref": reuse.trustedWorkflow.ref,
        "--trusted-workflow-sha": reuse.trustedWorkflow.sha,
        "--validate-run": "99",
      }),
      FRV_EVIDENCE_MANIFEST: JSON.stringify(sourceManifest),
      FRV_REUSED_CHILDREN: JSON.stringify(reusedEvidenceChildren()),
      FRV_VALIDATOR_ARGS: validatorArgs,
      FULL_RELEASE_EXECUTION_PLAN_PATH: output,
      FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(planInputs),
      GITHUB_RUN_ATTEMPT: "1",
      OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
      RERUN_GROUP: "all",
    });
    if (reuse.name.startsWith("wrong-")) {
      expect(result.status).toBe(2);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        sourceAdmission,
        blockers: [
          expect.objectContaining({
            kind: "reused_evidence_invalid",
            message: "reused source admission differs from the requested publication source",
          }),
        ],
      });
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      children: [
        expect.objectContaining({ key: "normalCi", runId: "101", source: "reused" }),
        expect.objectContaining({ key: "pluginPrerelease", runId: "202", source: "reused" }),
        expect.objectContaining({ key: "releaseChecks", runId: "303", source: "reused" }),
        expect.objectContaining({ key: "npmTelegram", selected: false }),
        expect.objectContaining({ key: "productPerformance", runId: "505", source: "reused" }),
      ],
      evidenceReuse: {
        changedPaths: reuse.changedPaths,
        evidenceSha: reuse.evidenceSha,
        policy: reuse.policy,
        requested: true,
        rootRunId: "99",
        runUrl: "https://example.invalid/runs/99",
        selectedRunId: "99",
        sourceManifest,
      },
      trustedWorkflow: reuse.trustedWorkflow,
    });
    expect(JSON.parse(readFileSync(validatorArgs, "utf8"))).toContain("--expected-selected-run-id");
  });

  it.each([
    { name: "owner-waived evidence", waived: true, mutation: "none", blocker: "" },
    {
      name: "changed source manifest",
      waived: false,
      mutation: "sha",
      blocker: "provenance_mismatch",
    },
    {
      name: "missing source waiver",
      waived: true,
      mutation: "waiver",
      blocker: "reused_evidence_invalid",
    },
  ])("revalidates $name at the Decision boundary", ({ waived, mutation, blocker }) => {
    const root = tempDirs.make("frv-reuse-decision-");
    const output = join(root, "decision.json");
    const executionPlanPath = join(root, "plan.json");
    const gh = join(root, "gh");
    const validator = join(root, "validator.mjs");
    const waiver = waived
      ? { telegramWaiver: "2026.8.1-owner-approved", targetVersion: "2026.8.1" }
      : {};
    const sourceManifest = { ...evidenceManifest(), validationInputs: waiver };
    const revalidatedManifest = structuredClone(sourceManifest);
    if (mutation === "sha") {
      revalidatedManifest.targetSha = "c".repeat(40);
    } else if (mutation === "waiver") {
      revalidatedManifest.validationInputs = {};
    }
    const sealedPlan = executionPlan(
      {
        rerunGroup: "ci",
        releaseProfile: "stable",
        children: { normalCi: { result: "success", runAttempt: 1, runId: "101" } },
        ...waiver,
      },
      {
        ...waiver,
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: TARGET_SHA,
          policy: "exact-target-full-validation-v1",
          requested: true,
          rootRunId: "99",
          runUrl: "https://example.invalid/runs/99",
          selectedRunId: "99",
          sourceManifest,
        },
      },
    );
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    writeFileSync(
      gh,
      `#!/bin/sh
case "$*" in
  *"/attempts/1/jobs?"*)
    printf '%s\\n' '{"name":"test","status":"completed","conclusion":"success","started_at":"2026-08-21T00:00:00Z","completed_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/jobs/1"}'
    exit 0
    ;;
esac
printf '%s\\n' '{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"completed","conclusion":"success","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101","actor":{"login":"github-actions[bot]"},"triggering_actor":{"login":"github-actions[bot]"},"repository":{"full_name":"openclaw/openclaw"}}'
`,
    );
    chmodSync(gh, 0o755);
    writeFileSync(
      validator,
      `console.log(JSON.stringify({
  children: ${JSON.stringify(reusedEvidenceChildren())},
  manifest: ${JSON.stringify(revalidatedManifest)},
  releaseProfile: "stable",
  rerunGroup: "ci"
}));\n`,
    );
    const result = runCollector("decision", {
      FAIL_FAST: "false",
      FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      FULL_RELEASE_STATE_PATH: output,
      OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
      PATH: `${root}:${process.env.PATH}`,
    });
    expect(result.status, result.stderr).not.toBe(2);
    const decision = JSON.parse(readFileSync(output, "utf8"));
    expect(result.status, JSON.stringify(decision.blockers)).toBe(blocker ? 1 : 0);
    expect(decision.state).toBe(blocker ? "blocked_complete" : "passed");
    if (blocker) {
      expect(decision.blockers).toContainEqual(expect.objectContaining({ kind: blocker }));
    } else {
      expect(decision.blockers).toEqual([]);
    }
  });

  it.each([
    { rerunGroup: "ci", childKey: "normalCi", jobName: "test", conclusion: "success" },
    {
      rerunGroup: "ci",
      childKey: "normalCi",
      jobName: "install-smoke (linux)",
      conclusion: "failure",
    },
  ])(
    "binds the $rerunGroup manifest to the candidate ($conclusion proof jobs)",
    ({ rerunGroup, childKey, jobName, conclusion }) => {
      const root = tempDirs.make("frv-generated-candidate-manifest-");
      const decisionPath = join(root, "decision.json");
      const drainPath = join(root, "drain.json");
      const executionPlanPath = join(root, "plan.json");
      const manifestPath = join(root, "manifest.json");
      const candidate = candidateBinding();
      const sealedPlan = executionPlan(
        { rerunGroup },
        { attemptEvidenceVersion: 2, candidate, candidateRequest: candidate.request },
      );
      const plannedChild = sealedPlan.children.find(
        (entry: Record<string, any>) => entry.key === childKey,
      );
      assert(plannedChild, "selected child is present in the sealed plan");
      const composite = composeReleaseAttemptJobs(
        [
          {
            jobs: [
              {
                completed_at: "2026-08-21T00:01:00Z",
                conclusion,
                html_url: "https://example.invalid/jobs/test",
                name: jobName,
                started_at: "2026-08-21T00:00:00Z",
                status: "completed",
              },
            ],
            runAttempt: 1,
          },
        ],
        { effectiveRunAttempt: 1, plannedRunAttempt: 1 },
      );
      const attempt = {
        compositeJobsSha256: composite.sha256,
        dispatchActor: "github-actions[bot]",
        jobs: composite.jobs,
        observedRunAttempts: [1],
        plannedRunAttempt: 1,
        repository: "openclaw/openclaw",
        runId: plannedChild.runId,
        triggeringActor: "github-actions[bot]",
      };
      const decisionArtifact = collectorArtifact("decision", 2, sealedPlan, {
        ...attempt,
        runAttempt: 1,
      });
      const drainArtifact = collectorArtifact("drain", 2, sealedPlan, {
        ...attempt,
        runAttempt: 1,
      });
      const childEvidence = { [childKey]: { ...attempt, effectiveRunAttempt: 1 } };
      const manifest = { ...generatedManifest(sealedPlan), childEvidence };
      writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
      writeFileSync(decisionPath, JSON.stringify(decisionArtifact));
      writeFileSync(drainPath, JSON.stringify(drainArtifact));
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const env = {
        DIAGNOSTIC_DRAIN_PATH: drainPath,
        RELEASE_DECISION_PATH: decisionPath,
        RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        RELEASE_VALIDATION_MANIFEST_PATH: manifestPath,
      };
      const valid = runCollector("validate-manifest", env);
      if (conclusion === "failure") {
        expect(valid.status).toBe(2);
        expect(valid.stderr).toContain("blocked_complete");
        expect(valid.stderr).toContain(jobName);
        return;
      }
      expect(valid.status, valid.stderr).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).advisoryJobs).toEqual([]);
      const changed = {
        ...manifest,
        candidateBinding: {
          ...candidate,
          evidenceArtifact: { ...candidate.evidenceArtifact, id: "999" },
        },
        childEvidence,
      };
      writeFileSync(manifestPath, JSON.stringify(changed));
      const invalid = runCollector("validate-manifest", env);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain("candidate");
    },
  );

  it.each([
    {
      mutate: (manifest: Record<string, any>) => {
        manifest.childRuns.normalCi = "999";
      },
      name: "wrong selected child",
      planReuse: false,
    },
    {
      mutate: (manifest: Record<string, any>) => {
        manifest.evidenceReuse.selectedRunId = "100";
      },
      name: "wrong evidence reuse tuple",
      planReuse: true,
    },
  ])("rejects a generated manifest with $name", ({ mutate, planReuse }) => {
    const root = tempDirs.make("frv-invalid-generated-manifest-");
    const executionPlanPath = join(root, "plan.json");
    const manifestPath = join(root, "manifest.json");
    const reuse = {
      changedPaths: [],
      evidenceSha: TARGET_SHA,
      policy: "exact-target-full-validation-v1",
      requested: true,
      rootRunId: "99",
      runUrl: "https://example.invalid/runs/99",
      selectedRunId: "99",
      sourceManifest: evidenceManifest(),
    };
    const sealedPlan = executionPlan(
      { rerunGroup: "ci" },
      planReuse ? { evidenceReuse: reuse } : {},
    );
    const manifest = generatedManifest(sealedPlan);
    if (planReuse) {
      manifest.evidenceReuse = {
        changedPaths: reuse.changedPaths,
        evidenceSha: reuse.evidenceSha,
        policy: reuse.policy,
        runId: reuse.rootRunId,
        selectedRunId: reuse.selectedRunId,
      };
    }
    mutate(manifest);
    writeFileSync(executionPlanPath, JSON.stringify(sealedPlan));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runCollector("validate-manifest", {
      RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      RELEASE_VALIDATION_MANIFEST_PATH: manifestPath,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "release validation manifest differs from the immutable execution plan",
    );
  });

  it("persists a rejected reuse plan for Release Decision to consume", () => {
    const root = tempDirs.make("frv-classified-plan-");
    const planPath = join(root, "plan.json");
    const decisionPath = join(root, "decision.json");
    const validator = join(root, "validator.mjs");
    writeFileSync(
      validator,
      'console.error("sealed reuse selection rejected"); process.exit(1);\n',
    );
    const env = {
      FULL_RELEASE_EXECUTION_PLAN_PATH: planPath,
      GITHUB_RUN_ATTEMPT: "1",
      OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
      RERUN_GROUP: "all",
    };
    const result = runCollector("plan", {
      ...env,
      FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(
        planInput({
          dockerPreflightResult: "skipped",
          evidenceChangedPaths: [],
          evidencePolicy: "exact-target-full-validation-v1",
          evidenceReuse: true,
          evidenceRootRunId: "99",
          evidenceRunId: "99",
          evidenceRunUrl: "https://example.invalid/runs/99",
          evidenceSha: TARGET_SHA,
        }),
      ),
    });
    expect(result.status, result.stderr).toBe(2);
    const blocker = expect.objectContaining({ kind: "reused_evidence_invalid" });
    expect(JSON.parse(readFileSync(planPath, "utf8"))).toMatchObject({
      blockers: [blocker],
      errors: [],
    });
    const decision = runCollector("decision", {
      ...env,
      FAIL_FAST: "false",
      FULL_RELEASE_STATE_PATH: decisionPath,
    });
    expect(decision.status, decision.stderr).toBe(1);
    expect(JSON.parse(readFileSync(decisionPath, "utf8"))).toMatchObject({
      state: "blocked_complete",
      blockers: expect.arrayContaining([blocker]),
      errors: [],
    });
  });

  it.each([{ dockerPreflightResult: "failure", packagePublished: true, retiredScenario: false }])(
    "restores packagePublished=$packagePublished, retiredScenario=$retiredScenario and the legacy $dockerPreflightResult Docker gate",
    ({ dockerPreflightResult, packagePublished }) => {
      const root = tempDirs.make("frv-plan-restore-");
      const output = join(root, "full-release-execution-plan.json");
      const githubOutput = join(root, "github-output");
      const candidate = candidateBinding({ packagePublished });
      const phasedChildren = {
        normalCi: { result: "success", runAttempt: 1, runId: "101" },
        pluginPrereleaseIndependent: { result: "success", runAttempt: 1, runId: "202" },
        pluginPrereleaseCandidate: { result: "success", runAttempt: 1, runId: "203" },
        releaseChecksIndependent: { result: "success", runAttempt: 1, runId: "303" },
        releaseChecksCandidate: { result: "success", runAttempt: 1, runId: "304" },
        npmTelegram: { result: "success", runAttempt: 1, runId: "404" },
        productPerformance: { result: "success", runAttempt: 1, runId: "505" },
      };
      const sealed = executionPlan(
        {
          candidateAcquisitionResult: "success",
          candidateRequired: true,
          childPhaseVersion: 3,
          children: phasedChildren,
        },
        {
          attemptEvidenceVersion: 3,
          candidate,
          candidateRequest: candidate.request,
        },
      );

      // Earlier producers required this gate for regular releases too. A collector
      // retry must preserve that recorded policy, including a failed gate.
      sealed.gates.push({
        name: "Verify Docker runtime image assets",
        required: true,
        result: dockerPreflightResult,
      });
      sealed.sha256 = releaseExecutionPlanSha256(sealed);
      writeFileSync(output, JSON.stringify(sealed));
      const result = runCollector("plan", {
        CANDIDATE_REQUEST_JSON: JSON.stringify(candidate.request),
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_PLAN_INPUTS_JSON: "must-not-be-read-during-restore",
        FULL_RELEASE_RESTORE_PLAN: "true",
        GITHUB_OUTPUT: githubOutput,
        RERUN_GROUP: "all",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(sealed);
      expect(readFileSync(githubOutput, "utf8")).toContain("source_parent_attempt=1\n");
    },
  );

  it.each([
    {
      mutate: (artifact: Record<string, any>) => {
        artifact.parentRunAttempt = 2;
      },
      name: "wrong source parent attempt",
    },
    {
      mutate: (artifact: Record<string, any>) => {
        artifact.children[0].workflow = "plugin-prerelease.yml";
      },
      name: "wrong child identity",
    },
  ])("rejects restored execution plan artifact with $name", ({ mutate }) => {
    const artifact = structuredClone(executionPlan({ rerunGroup: "ci" }));
    mutate(artifact);
    artifact.sha256 = releaseExecutionPlanSha256(artifact);
    expect(() =>
      validateReleaseExecutionPlanArtifact(artifact, {
        parentRunId: "77",
        releaseProfile: "stable",
        rerunGroup: "ci",
        sourceParentRunAttempt: 1,
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/tooling",
        workflowSha: SHA,
      }),
    ).toThrow(/release execution plan (artifact binding|child identity) is invalid/u);
  });

  it("writes the admitted execution plan when SIGTERM interrupts a stalled reuse API", async ({
    onTestFinished,
    signal,
  }) => {
    const root = tempDirs.make("frv-plan-signal-");
    const gh = join(root, "gh");
    const ghReady = join(root, "gh-ready");
    const output = join(root, "full-release-execution-plan.json");
    const sourceAdmission = sourceFact({
      coverage: { ...sourceFact().coverage, rerun_group: "ci" },
    });
    const publication = registryRecord(sourceAdmission);
    const publicationPath = join(root, "publication.json");
    writeFileSync(publicationPath, JSON.stringify(publication));
    writeFileSync(
      gh,
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
writeFileSync(process.env.FRV_GH_READY, "ready");
sendReceipt(process.env.FRV_GH_READY, "ready");
setTimeout(() => {}, 30000);
`,
    );
    chmodSync(gh, 0o755);
    const childProcess = spawn(process.execPath, [SCRIPT, "plan"], {
      env: collectorEnv({
        EVIDENCE_CHANGED_PATHS: "[]",
        FRV_GH_READY: ghReady,
        FULL_RELEASE_EXECUTION_PLAN_PATH: output,
        FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1",
        FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1",
        PUBLICATION_ADMISSION_PATH: publicationPath,
        FULL_RELEASE_PLAN_INPUTS_JSON: JSON.stringify(
          planInput({
            sourceAdmissionContract: "1",
            sourceAdmission,
            children: { normalCi: { result: "skipped", runAttempt: "", runId: "" } },
            dockerPreflightResult: "skipped",
            evidenceChangedPaths: [],
            evidencePolicy: "exact-target-full-validation-v1",
            evidenceReuse: true,
            evidenceRootRunId: "99",
            evidenceRunId: "99",
            evidenceRunUrl: "https://example.invalid/runs/99",
            evidenceSha: TARGET_SHA,
            rerunGroup: "ci",
          }),
        ),
        GITHUB_RUN_ATTEMPT: "1",
        PATH: `${root}:${process.env.PATH}`,
      }),
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const exitPromise = collectorClosed(childProcess);
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => (cleanupPromise ??= stopCollector(childProcess, exitPromise));
    onTestFinished(cleanup);
    try {
      await withinTest(fixtureReadyBeforeSettlement(ghReady, exitPromise), signal);
      const started = Date.now();
      expect(childProcess.kill("SIGTERM")).toBe(true);
      await expect(withinTest(exitPromise, signal)).resolves.toEqual({ code: 1, signal: null });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        ...publication,
        errors: [expect.objectContaining({ kind: "collector_cancelled" })],
        parentRunAttempt: 1,
      });
    } finally {
      await cleanup();
    }
  });

  it("records target resolution failure even when no target SHA exists", () => {
    const root = tempDirs.make("frv-state-target-failure-");
    const output = join(root, "decision.json");
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan(
          {
            children: { normalCi: { result: "skipped", runAttempt: "", runId: "" } },
            dockerPreflightResult: "skipped",
            candidateBindingResult: "skipped",
            rerunGroup: "ci",
            resolveTargetResult: "failure",
          },
          {
            expected: {
              parentRunAttempt: 1,
              parentRunId: "77",
              targetSha: "",
              workflowRef: "release-ci/tooling",
              workflowSha: SHA,
            },
          },
        ),
      ),
    );
    const result = runCollector("decision", {
      FAIL_FAST: "false",
      FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      FULL_RELEASE_STATE_PATH: output,
      TARGET_SHA: "",
    });
    expect(result.status, result.stderr).toBe(1);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact).toMatchObject({
      state: "blocked_complete",
      targetSha: "",
    });
    expect(artifact.blockers).toContainEqual(
      expect.objectContaining({
        kind: "parent_gate_failure",
        message: expect.stringContaining("Resolve target ref"),
      }),
    );
  });

  it("writes an immediate terminal handoff with active identity on SIGTERM", async ({
    onTestFinished,
    signal,
  }) => {
    const root = tempDirs.make("frv-state-signal-");
    const gh = join(root, "gh");
    const ghReady = join(root, "gh-ready");
    const output = join(root, "drain.json");
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(
      executionPlanPath,
      JSON.stringify(
        executionPlan({
          children: { normalCi: { result: "success", runAttempt: 1, runId: "101" } },
          dockerPreflightResult: "skipped",
          candidateBindingResult: "skipped",
          rerunGroup: "ci",
          resolveTargetResult: "success",
        }),
      ),
    );
    writeFileSync(
      gh,
      `#!${process.execPath}
import { writeFileSync } from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
writeFileSync(process.env.FRV_GH_READY, "ready");
sendReceipt(process.env.FRV_GH_READY, "ready");
if (process.argv.slice(2).join(" ") !== "api --paginate repos/openclaw/openclaw/actions/runs/101/attempts/1/jobs?per_page=100 --jq .jobs[] | @json") {
  console.log('{"id":101,"event":"workflow_dispatch","path":".github/workflows/ci.yml@refs/heads/release-ci/tooling","display_title":"CI full-release-validation-77-1-ci","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"in_progress","conclusion":null,"created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/101","actor":{"login":"github-actions[bot]"},"triggering_actor":{"login":"github-actions[bot]"},"repository":{"full_name":"openclaw/openclaw"}}');
}
`,
    );
    chmodSync(gh, 0o755);
    const childProcess = spawn(process.execPath, [SCRIPT, "drain"], {
      env: collectorEnv({
        FAIL_FAST: "false",
        FRV_GH_READY: ghReady,
        FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
        FULL_RELEASE_POLL_INTERVAL_MS: "60000",
        FULL_RELEASE_STATE_PATH: output,
        PATH: `${root}:${process.env.PATH}`,
        TARGET_SHA: "b".repeat(40),
      }),
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    const exitPromise = collectorClosed(childProcess);
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => (cleanupPromise ??= stopCollector(childProcess, exitPromise));
    onTestFinished(cleanup);
    try {
      await withinTest(fixtureReadyBeforeSettlement(ghReady, exitPromise), signal);
      expect(childProcess.kill("SIGTERM")).toBe(true);
      await expect(withinTest(exitPromise, signal)).resolves.toEqual({ code: 1, signal: null });
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        activeRunIds: ["101"],
        cancellation: { requested: true },
        state: "cancelled_with_children",
      });
    } finally {
      await cleanup();
    }
  });

  it("cancels only the exact affected child and never cancels from drain", () => {
    const root = tempDirs.make("frv-state-fail-fast-");
    const gh = join(root, "gh");
    const calls = join(root, "calls");
    writeFileSync(calls, "");
    writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FRV_GH_CALLS"
if [ "$1" = "run" ] && [ "$2" = "cancel" ]; then
  exit 0
fi
case "$*" in
  *"/jobs?"*)
    case "$*" in
      *"/101/"*) printf '%s\\n' '{"name":"upgrade-survivor","status":"completed","conclusion":"failure","html_url":"https://example.invalid/jobs/test"}' ;;
    esac
    exit 0
    ;;
esac
endpoint="$2"
[ "$endpoint" = "--paginate" ] && endpoint="$3"
run_id=$(printf '%s' "$endpoint" | sed 's#^.*/##')
title="CI full-release-validation-77-1-ci"
workflow="ci.yml"
case "$run_id" in
  202) title="Plugin Prerelease full-release-validation-77-1-plugin-prerelease"; workflow="plugin-prerelease.yml" ;;
  303) title="OpenClaw Release Checks full-release-validation-77-1-release-checks"; workflow="openclaw-release-checks.yml" ;;
  505) title="OpenClaw Performance full-release-validation-77-1"; workflow="openclaw-performance.yml" ;;
esac
status="completed"
[ "$run_id" = 101 ] && status="$FRV_FAILED_RUN_STATUS"
printf '{"id":%s,"event":"workflow_dispatch","path":".github/workflows/%s@refs/heads/release-ci/tooling","display_title":"%s","head_branch":"release-ci/tooling","head_sha":"${SHA}","run_attempt":1,"status":"%s","conclusion":"%s","created_at":"2026-08-21T00:00:00Z","updated_at":"2026-08-21T00:01:00Z","html_url":"https://example.invalid/runs/%s","actor":{"login":"github-actions[bot]"},"triggering_actor":{"login":"github-actions[bot]"},"repository":{"full_name":"openclaw/openclaw"}}\\n' "$run_id" "$workflow" "$title" "$status" "$([ "$run_id" = 101 ] && echo failure || echo success)" "$run_id"
`,
    );
    chmodSync(gh, 0o755);
    const executionPlanPath = join(root, "full-release-execution-plan.json");
    writeFileSync(executionPlanPath, JSON.stringify(executionPlan()));
    const baseEnv = {
      FRV_GH_CALLS: calls,
      FULL_RELEASE_EXECUTION_PLAN_PATH: executionPlanPath,
      PATH: `${root}:${process.env.PATH}`,
      RERUN_GROUP: "all",
      TARGET_SHA: "b".repeat(40),
    };
    const decision = runCollector("decision", {
      ...baseEnv,
      FAIL_FAST: "true",
      FRV_FAILED_RUN_STATUS: "in_progress",
      FULL_RELEASE_STATE_PATH: join(root, "decision.json"),
    });
    expect(decision.signal, decision.stderr).toBeNull();
    const afterDecision = readFileSync(calls, "utf8");
    expect(afterDecision).toContain("run cancel 101");
    expect(afterDecision).not.toContain("run cancel 202");
    writeFileSync(calls, "");
    const drain = runCollector("drain", {
      ...baseEnv,
      FAIL_FAST: "false",
      FRV_FAILED_RUN_STATUS: "completed",
      FULL_RELEASE_STATE_PATH: join(root, "drain.json"),
    });
    expect(drain.signal, drain.stderr).toBeNull();
    expect(readFileSync(calls, "utf8")).not.toContain("run cancel");
  });
});
