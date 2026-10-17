import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPublicationSourceFact,
  publicationDispatchEnvelope,
  publicationIntentInputs,
  publicationSourceRequest,
  type PublicationSelection,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  isShaPinnedReleaseValidationBranch,
  normalizeFullReleaseValidationRun,
  validateFullReleaseValidationEvidence as validateEvidence,
} from "../../scripts/validate-full-release-validation-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

function checkEvidence(
  options: Partial<Parameters<typeof validateEvidence>[0]> & {
    branch?: string;
    sha?: string;
    manifestOverrides?: Record<string, unknown>;
  },
) {
  const { branch = pinnedBranch, sha = workflowSha, manifestOverrides, ...validation } = options;
  return validateEvidence({
    run: releaseRun({ head_branch: branch, head_sha: sha }),
    manifest: releaseManifest({
      workflowRef: branch,
      workflowFullRef: `refs/heads/${branch}`,
      workflowSha: sha,
      ...manifestOverrides,
    }),
    expectedRepository: "openclaw/openclaw",
    expectedRunId: "123",
    expectedTargetSha: targetSha,
    isTrustedMainAncestor: () => true,
    getWorkflowSource: () =>
      'name: Full Release Validation\nenv:\n  RELEASE_ISOLATION_TOOLING_CONTRACT: "2"\n',
    ...validation,
  });
}

const targetSha = "b".repeat(40);
const workflowSha = "a".repeat(40);
const publisherWorkflowSha = "c".repeat(40);
const pinnedBranch = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reads delayed piped run metadata before enforcing the CLI consumer boundary", async () => {
  const manifestPath = join(tempDirs.make("release-evidence-stdin-"), "manifest.json");
  writeFileSync(manifestPath, "{}");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../scripts/validate-full-release-validation-evidence.mjs", import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        MANIFEST_FILE: manifestPath,
        PUBLICATION_CONSUMER: "invalid-consumer",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  const stdout = text(child.stdout);
  const stderr = text(child.stderr);
  const inputErrors: Error[] = [];
  child.stdin.on("error", (error) => inputErrors.push(error));
  try {
    child.stdin.write('{"id":');
    // Model gh api delivering a later chunk while the nonblocking pipe stays open.
    await delay(250);
    child.stdin.end("123}");
    const [code] = await exited;
    expect(await stderr).toBe("Unknown publication evidence consumer.\n");
    expect(code).toBe(1);
    expect(await stdout).toBe("");
    expect(inputErrors).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
});

function releaseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    run_attempt: 2,
    name: "Full Release Validation",
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: "openclaw/openclaw" },
    head_branch: pinnedBranch,
    head_sha: workflowSha,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/openclaw/openclaw/actions/runs/123",
    ...overrides,
  };
}

function releaseManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    workflowName: "Full Release Validation",
    runId: "123",
    runAttempt: "2",
    workflowRef: pinnedBranch,
    workflowSha,
    workflowFullRef: `refs/heads/${pinnedBranch}`,
    workflowRefType: "branch",
    targetRef: targetSha,
    targetSha,
    ...overrides,
  };
}

function exactTargetEvidenceReuse() {
  return {
    changedPaths: [],
    evidenceSha: targetSha,
    policy: "exact-target-full-validation-v1",
    runId: "122",
    selectedRunId: "122",
  };
}

function strictEvidenceReuse(version = 3) {
  return {
    schema: `openclaw.release-validation-evidence/v${version}`,
    valid: true,
    current: { runId: "123", targetSha },
    root: { runId: "122", targetSha },
    evidenceReuse: {
      changedPaths: [],
      evidenceSha: targetSha,
      policy: "exact-target-full-validation-v1",
      rootRunId: "122",
      selectedRunId: "122",
    },
    conclusions: { allRequiredSucceeded: true },
  };
}

function validate(
  runOverrides: Record<string, unknown> = {},
  manifestOverrides: Record<string, unknown> = {},
  trusted = true,
) {
  const isTrustedMainAncestor = vi.fn(() => trusted);
  const result = checkEvidence({
    run: releaseRun(runOverrides),
    manifest: releaseManifest(manifestOverrides),
    expectedWorkflowBranch: "release/2026.7.1",
    isTrustedMainAncestor,
    validateEvidenceReuseStrictly: () =>
      strictEvidenceReuse(Number(manifestOverrides.version ?? 3)),
  });
  return { isTrustedMainAncestor, result };
}

describe("full release validation evidence", () => {
  it("rejects retained windows-node-ci advisory evidence under current strict tooling (v4)", () => {
    const job = {
      name: "checks-windows-node-test-2",
      status: "completed",
      conclusion: "failure",
    };
    expect(() =>
      validate(
        {},
        {
          version: 4,
          childEvidence: { normalCi: { jobs: [job] } },
          advisoryJobs: [
            {
              class: "windows-node-ci",
              child: "normalCi",
              job: job.name,
              conclusion: job.conclusion,
            },
          ],
        },
      ),
    ).toThrow("Release manifest contains failed selected job evidence");
  });

  it.each([
    { publishInputs: { stableSoakWaiver: "approved" } },
    { validationInputs: { knownFlakyJobsJson: '["checks-windows-node-test-2"]' } },
  ])("rejects retired waiver inputs before accepting direct evidence: %j", (inputs) => {
    expect(() => validate({}, inputs)).toThrow(/waivers|knownFlakyJobsJson/u);
  });

  it.each([
    "publish",
    "diagnostic",
    "missing",
    "selection",
    "windows-after-admission",
    "context",
    "tooling",
    "missing-publication",
    "new-publish-without-admission",
  ])("authenticates new source-admission evidence: %s", (scenario) => {
    const selection: PublicationSelection = {
      route: "normal",
      npmDistTag: "latest",
      publishOpenclawNpm: true,
      pluginPublishScope: "all-publishable",
      plugins: [],
    };
    const request = publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        ref: targetSha,
        trusted_workflow_json: publicationDispatchEnvelope(null, {
          validationPurpose: scenario === "diagnostic" ? "diagnostic" : "publish",
          publicationSelection: scenario === "diagnostic" ? null : selection,
        }),
        release_profile: "full",
        rerun_group: "all",
      }),
      PUBLICATION_TARGET_CONTEXT: "release/2026.9.9",
      PUBLICATION_TOOLING_JSON: JSON.stringify({ fullRef: "refs/heads/main", sha: workflowSha }),
      PUBLICATION_TARGET_SHA: targetSha,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: `refs/heads/${pinnedBranch}`,
      GITHUB_SHA: workflowSha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    });
    const source = createPublicationSourceFact(
      request,
      scenario === "diagnostic" ? null : { packages: [], platforms: [] },
      scenario === "diagnostic"
        ? null
        : {
            version: "2026.9.9",
            packages: [{ name: "openclaw", version: "2026.9.9", targets: ["npm"] }],
            platforms: [],
          },
    );
    const manifest = releaseManifest({
      sourceAdmissionContract: "1",
      sourceAdmission: source,
      releaseProfile: "full",
      rerunGroup: "all",
      runReleaseSoak: "true",
      trustedWorkflow: {
        fullRef: scenario === "tooling" ? "refs/heads/other" : "refs/heads/main",
        sha: workflowSha,
      },
      validationInputs: {
        ...publicationIntentInputs(source),
        targetContextRef: scenario === "context" ? "release/2026.9.8" : "release/2026.9.9",
        allowUnreleasedChangelog: "false",
      },
    });
    if (scenario === "missing") {
      delete (manifest as Record<string, unknown>).sourceAdmission;
      delete (manifest as Record<string, unknown>).sourceAdmissionContract;
    }
    const run = () =>
      checkEvidence({
        manifest,
        getWorkflowSource: () =>
          'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n' +
          (scenario === "new-publish-without-admission"
            ? '  FULL_RELEASE_QUALIFICATION_ADMISSION_CONTRACT: "1"\n'
            : "") +
          (scenario === "missing-publication"
            ? '  FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1"\n'
            : ""),
        expectedPublicationSelection: (): PublicationSelection => ({
          ...selection,
          route: scenario === "selection" ? "prepared" : "normal",
          ...(scenario === "windows-after-admission"
            ? {
                windowsNodeTag: "v0.6.3",
                windowsNodeInstallerDigests: {
                  "OpenClawCompanion-Setup-x64.exe": `sha256:${"d".repeat(64)}`,
                },
              }
            : {}),
        }),
      });
    if (scenario === "windows-after-admission") {
      expect(run).toThrow("windows-node-release.yml");
    } else if (scenario === "publish") {
      expect(run).not.toThrow();
    } else {
      expect(run).toThrow(
        /source.admission|source admission|publication|cannot prepare publication/iu,
      );
    }
  });

  it.each([
    ["beta", "2026.8.28-beta.1", "", "v2026.8.28-beta.1", true],
    ["beta", "2026.8.28-beta.1", "", "v2026.8.28-beta.2", false],
    ["stable", "2026.8.28", "v2026.8.28", "v2026.8.28", true],
    ["stable", "2026.8.28", "release/2026.8.28-1", "v2026.8.28-1", true],
    ["stable", "2026.8.28", "release/2026.8.27", "v2026.8.28", false],
    ["stable", "2026.8.28", "", "v2026.8.28", false],
    ["stable", "2026.8.33", "extended-stable/2026.8.33", "v2026.8.33", false],
  ] as const)(
    "binds npm %s evidence %s/%s to final publication %s",
    (profile, targetVersion, context, expectedReleaseTag, accepted) => {
      const validateEvidenceReuseStrictly = vi.fn();
      const coveragePolicy = `npm-${profile}-v1`;
      const run = () =>
        checkEvidence({
          branch: profile === "beta" && accepted ? pinnedBranch : "main",
          manifestOverrides: {
            version: 4,
            releaseProfile: profile,
            rerunGroup: "all",
            runReleaseSoak: String(profile === "stable"),
            targetRef: context.startsWith("v") ? context : targetSha,
            validationInputs: {
              coveragePolicy,
              targetContextRef: context.startsWith("v") ? "" : context,
              targetVersion,
            },
          },
          expectedReleaseTag,
          validateEvidenceReuseStrictly,
        });
      if (accepted) {
        expect(run().coveragePolicy).toBe(coveragePolicy);
        expect(validateEvidenceReuseStrictly).not.toHaveBeenCalled();
      } else if (profile === "beta") {
        expect(run).toThrow(/coverage policy/iu);
      } else {
        expect(run).toThrow();
      }
    },
  );

  it("normalizes REST and gh run metadata", () => {
    const normalized = normalizeFullReleaseValidationRun(releaseRun());

    expect(normalized).toMatchObject({
      databaseId: "123",
      runAttempt: 2,
      workflowName: "Full Release Validation",
      workflowPath: ".github/workflows/full-release-validation.yml",
      repository: "openclaw/openclaw",
      headBranch: pinnedBranch,
      headSha: workflowSha,
    });
    expect(
      normalizeFullReleaseValidationRun({
        databaseId: 123,
        attempt: 2,
        workflowName: "Full Release Validation",
        workflowPath: ".github/workflows/full-release-validation.yml@refs/heads/main",
      }),
    ).toMatchObject({
      databaseId: "123",
      runAttempt: 2,
      workflowPath: ".github/workflows/full-release-validation.yml",
      workflowQualifiedRef: "refs/heads/main",
    });
  });

  it("accepts v4 SHA-pinned evidence bound to current main", () => {
    const { isTrustedMainAncestor, result } = validate({}, { version: 4 });
    expect(result.source).toBe("sha-pinned-main");
    expect(isTrustedMainAncestor).toHaveBeenCalledWith(workflowSha);
    expect(isShaPinnedReleaseValidationBranch(pinnedBranch)).toBe(true);
  });

  it.each([false, true])("accepts protected tooling evidence (historical: %s)", (historical) => {
    const sha = historical ? publisherWorkflowSha : workflowSha;
    const isTrustedMainAncestor = vi.fn(() => historical);
    const validateEvidenceReuseStrictly = vi.fn(() => strictEvidenceReuse(4));
    const result = checkEvidence({
      manifestOverrides: historical
        ? { version: 4, evidenceReuse: exactTargetEvidenceReuse() }
        : {},
      expectedTrustedWorkflowFullRef: `refs/tags/release-publish/${sha.slice(0, 12)}-123`,
      expectedTrustedWorkflowSha: sha,
      isTrustedMainAncestor,
      validateEvidenceReuseStrictly,
    });
    expect(result.source).toBe(`sha-pinned-protected-tag${historical ? "-main-ancestor" : ""}`);
    if (historical) {
      expect(isTrustedMainAncestor).toHaveBeenCalledWith(workflowSha);
      expect(validateEvidenceReuseStrictly).toHaveBeenCalledWith({
        repository: "openclaw/openclaw",
        runId: "123",
        targetSha,
      });
    } else {
      expect(isTrustedMainAncestor).not.toHaveBeenCalled();
      expect(validateEvidenceReuseStrictly).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["same-name branch", "must be an exact protected tag"],
    ["untrusted ancestor", "not reachable from current main"],
    ["noncanonical producer", "canonical release-ci producer branch"],
  ])("rejects protected-tag evidence from %s", (scenario, message) => {
    const trustedWorkflowRef = `release-publish/${workflowSha.slice(0, 12)}-123`;
    const historical = scenario === "untrusted ancestor";
    const producerBranch = scenario === "same-name branch" ? pinnedBranch : trustedWorkflowRef;
    expect(() =>
      checkEvidence({
        branch: historical
          ? `release-ci/${publisherWorkflowSha.slice(0, 12)}-1783705000000`
          : producerBranch,
        sha: historical ? publisherWorkflowSha : workflowSha,
        expectedTrustedWorkflowFullRef: `refs/${scenario === "same-name branch" ? "heads" : "tags"}/${trustedWorkflowRef}`,
        expectedTrustedWorkflowSha: workflowSha,
        isTrustedMainAncestor: () => !historical,
      }),
    ).toThrow(message);
  });

  it("accepts a REST workflow path qualified with release-ci/aaaaaaaaaaaa-1783705000000", () => {
    const { result } = validate({
      path: `.github/workflows/full-release-validation.yml@${pinnedBranch}`,
    });
    expect(result.source).toBe("sha-pinned-main");
  });

  it.each([
    ["main", { targetRef: "v2026.7.1-beta.3" }, false, "not reachable from current main"],
    [pinnedBranch, {}, false, "not reachable from current main"],
    [`release-ci/${"c".repeat(12)}-1783705000000`, {}, true, "does not match workflow SHA"],
    ["release-ci/not-canonical", {}, true, "untrusted head branch"],
  ] as const)("rejects untrusted producer %s", (branch, manifestOverrides, trusted, message) => {
    expect(() =>
      checkEvidence({
        branch,
        manifestOverrides,
        expectedWorkflowBranch: branch,
        isTrustedMainAncestor: () => trusted,
      }),
    ).toThrow(message);
  });

  it.each([
    ["repository", { repository: { full_name: "attacker/openclaw" } }, {}, "repository"],
    ["workflow path", { path: ".github/workflows/other.yml" }, {}, "workflowPath"],
    [
      "qualified workflow ref",
      { path: ".github/workflows/full-release-validation.yml@refs/heads/other" },
      {},
      "workflow path ref",
    ],
    ["run id", { id: 124 }, {}, "databaseId"],
    ["run attempt", {}, { runAttempt: "1" }, "runAttempt"],
    ["workflow SHA", {}, { workflowSha: "c".repeat(40) }, "workflowSha"],
    ["target SHA", {}, { targetSha: "c".repeat(40) }, "targetSha"],
    ["target ref", {}, { targetRef: "v2026.7.1-beta.3" }, "target ref"],
    ["manifest version", {}, { version: 2 }, "version 3"],
  ])("rejects mismatched %s", (_name, runOverrides, manifestOverrides, message) => {
    expect(() => validate(runOverrides, manifestOverrides)).toThrow(message);
  });

  it("accepts v4 split-changelog-release-v1 evidence reuse on the SHA-pinned path", () => {
    const codeSha = "c".repeat(40);
    const reuse = {
      changedPaths: ["CHANGELOG/2026.7.1.md", "CHANGELOG/records/2026.7.1.md"],
      evidenceSha: codeSha,
      policy: "split-changelog-release-v1",
      runId: "122",
      selectedRunId: "122",
    };
    const result = checkEvidence({
      manifestOverrides: {
        version: 4,
        evidenceReuse: reuse,
        validationInputs: { targetVersion: "2026.7.1" },
      },
      expectedWorkflowBranch: "release/2026.7.1",
      validateEvidenceReuseStrictly: () => ({
        ...strictEvidenceReuse(4),
        root: { runId: "122", targetSha: codeSha },
        evidenceReuse: {
          ...reuse,
          rootRunId: "122",
        },
      }),
    });

    expect(result.source).toBe("sha-pinned-main");
  });

  it.each([
    [undefined, "requires strict chain validation"],
    [
      () => ({ ...strictEvidenceReuse(), conclusions: { allRequiredSucceeded: false } }),
      "failed strict chain validation",
    ],
  ] as const)(
    "requires strict root and child validation: %s",
    (validateEvidenceReuseStrictly, message) => {
      expect(() =>
        checkEvidence({
          manifestOverrides: { evidenceReuse: exactTargetEvidenceReuse() },
          expectedWorkflowBranch: "release/2026.7.1",
          validateEvidenceReuseStrictly,
        }),
      ).toThrow(message);
    },
  );

  it.each([
    { changedPaths: ["src/a.ts"] },
    { evidenceSha: "c".repeat(40) },
    {
      changedPaths: ["src/a.ts"],
      evidenceSha: "c".repeat(40),
      policy: "changelog-only-release-v1",
    },
  ])("rejects malformed evidence reuse on the SHA-pinned path: %j", (overrides) => {
    expect(() =>
      validate({}, { evidenceReuse: { ...exactTargetEvidenceReuse(), ...overrides } }),
    ).toThrow("evidence reuse is invalid");
  });

  it("keeps a pinned-shaped expected branch on the pinned trust path", () => {
    expect(() =>
      checkEvidence({
        manifestOverrides: {
          evidenceReuse: { ...exactTargetEvidenceReuse(), selectedRunId: "" },
        },
        expectedWorkflowBranch: pinnedBranch,
        validateEvidenceReuseStrictly: () => strictEvidenceReuse(),
      }),
    ).toThrow("evidence reuse is invalid");
  });
});
