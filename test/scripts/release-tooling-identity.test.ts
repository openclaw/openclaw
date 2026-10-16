import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  downloadFullReleaseNpmPreflight,
  resolveFullReleaseNpmPreflight,
  validateNpmPreflightProducer,
  validateFullReleaseNpmPreflight,
  verifyNpmPreflightProducer,
  verifyReleasePreflightToolingIdentity,
} from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  resolveReleaseToolingIdentity,
  validateReleasePublishParentRun,
  validateReleaseToolingIdentity,
  verifyReleaseToolingIdentity,
  verifyReleaseWorkflowRun,
} from "../../scripts/release-tooling-identity.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RUN_ID = "12345";
const PARENT_RUN_ID = "67890";
const PARENT_RUN_ATTEMPT = "2";
const REF = `release-publish/${SHA.slice(0, 12)}-${RUN_ID}`;
const FULL_REF = `refs/tags/${REF}`;
const releaseCiRef = `release-ci/${SHA.slice(0, 12)}-123`;
const identityJson = (sha = SHA, ref = "main") =>
  JSON.stringify({ ref, fullRef: `refs/heads/${ref}`, sha });
const artifactMetadata = (artifact: { name: string; digest: string }) => ({
  id: 555,
  name: artifact.name,
  digest: `sha256:${artifact.digest}`,
  expired: false,
  workflow_run: { id: Number(RUN_ID), head_sha: SHA },
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const executing = (ref = "main") => ({
  workflowContract: "2",
  workflowRef: ref,
  workflowFullRef: `refs/heads/${ref}`,
  workflowSha: SHA,
});
const parentRun = (overrides = {}) => ({
  id: Number(PARENT_RUN_ID),
  run_attempt: Number(PARENT_RUN_ATTEMPT),
  repository: { full_name: "openclaw/openclaw" },
  path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: SHA,
  status: "in_progress",
  conclusion: null,
  ...overrides,
});
const parentIdentity = () => ({
  identity: { ref: REF, fullRef: FULL_REF, sha: SHA },
  releasePublishFullRef: "refs/heads/main",
  releasePublishRef: "main",
  releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
  releasePublishRunId: PARENT_RUN_ID,
  repository: "openclaw/openclaw",
});

function protectedIdentity(
  overrides: Partial<Parameters<typeof verifyReleaseToolingIdentity>[0]> = {},
) {
  return {
    repository: "openclaw/openclaw",
    workflowFullRef: FULL_REF,
    workflowRef: REF,
    workflowSha: SHA,
    ...overrides,
  };
}

describe("release tooling identity", () => {
  it.each([
    [
      "raw commit transport",
      executing(SHA),
      "workflow ref is not a trusted direct, release-ci, or protected-tag route",
    ],
    [
      "unsupported contract",
      { ...executing(), requestedIdentityJson: identityJson(), workflowContract: "3" },
      "release tooling contract 3 is not supported",
    ],
    [
      "implicit protected tag",
      { ...executing(REF), workflowFullRef: FULL_REF },
      /requires explicit trusted workflow identity|require explicit trusted workflow/u,
    ],
    [
      "wrong release-ci prefix",
      {
        ...executing(`release-ci/${OTHER_SHA.slice(0, 12)}-123`),
        requestedIdentityJson: identityJson(),
      },
      "release-ci workflow ref does not match the workflow SHA",
    ],
    [
      "candidate substituted for tooling",
      { ...executing(releaseCiRef), requestedIdentityJson: identityJson(OTHER_SHA) },
      "release-ci workflow identity must be trusted main",
    ],
    [
      "mismatched direct identity",
      { ...executing(), requestedIdentityJson: identityJson(OTHER_SHA) },
      "must match the executing workflow ref and SHA",
    ],
  ] as const)("rejects %s", (_label, input, error) => {
    expect(() => resolveReleaseToolingIdentity(input)).toThrow(error);
  });

  it.each([
    ["direct release", "release/2026.8.1", undefined, "release/2026.8.1"],
    ["release-ci", releaseCiRef, identityJson(), "main"],
  ])("resolves the %s identity", (_label, ref, requestedIdentityJson, expectedRef) => {
    expect(resolveReleaseToolingIdentity({ ...executing(ref), requestedIdentityJson })).toEqual({
      ref: expectedRef,
      fullRef: `refs/heads/${expectedRef}`,
      sha: SHA,
    });
  });

  it("rejects retired Tideclaw tooling even when prevalidated", () => {
    const identity = executing("tideclaw/alpha/2026-08-21-1200Z");
    expect(() => resolveReleaseToolingIdentity({ ...identity, workflowContract: "2" })).toThrow(
      "Alpha releases are retired;",
    );
    expect(() =>
      validateReleaseToolingIdentity({ ...identity, allowPrevalidatedRef: true }),
    ).toThrow("Alpha releases are retired;");
  });

  it("loads candidate qualification admission without deadlocking the CLI module cycle", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/release-tooling-identity.mjs"),
        "resolve",
        ...Object.entries({
          "qualification-admission-json": "{}",
          "qualification-inputs-json": "{}",
          "candidate-sha": SHA,
          repository: "openclaw/openclaw",
          "workflow-contract": "2",
          "workflow-ref": releaseCiRef,
          "workflow-full-ref": `refs/heads/${releaseCiRef}`,
          "workflow-sha": SHA,
          "requested-identity-json": identityJson(SHA, releaseCiRef),
        }).flatMap(([key, value]) => [`--${key}`, value]),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid admission descriptor fields");
    expect(result.stderr).not.toContain("unsettled top-level await");
  });

  it("rejects a deleted tag", () => {
    expect(() =>
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        runGh: () => {
          throw new Error("HTTP 404");
        },
      }),
    ).toThrow("missing or unreadable");
  });

  it("rejects a prevalidated branch moved after approval", () => {
    expect(() =>
      verifyReleaseToolingIdentity({
        allowPrevalidatedRef: true,
        ...protectedIdentity(),
        runGh: () =>
          JSON.stringify({
            ref: "refs/heads/release/2026.8.1",
            object: { sha: OTHER_SHA, type: "commit" },
          }),
        workflowFullRef: "refs/heads/release/2026.8.1",
        workflowRef: "release/2026.8.1",
        workflowSha: SHA,
      }),
    ).toThrow("branch is missing or moved");
  });

  it("binds a distinct current parent run independently from tag provenance", () => {
    const runGh = vi.fn((args: string[]) => {
      if (args[1]?.includes("/git/ref/tags/")) {
        return JSON.stringify({
          ref: FULL_REF,
          object: { sha: SHA, type: "commit" },
        });
      }
      return JSON.stringify(parentRun());
    });

    expect(
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        releasePublishFullRef: "refs/heads/main",
        releasePublishParentStatePolicy: "active",
        releasePublishRef: "main",
        releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
        releasePublishRunId: PARENT_RUN_ID,
        runGh,
      }),
    ).toMatchObject({ route: "protected-tag", sha: SHA });
    expect(runGh.mock.calls.map(([args]) => args)).toContainEqual([
      "api",
      `repos/openclaw/openclaw/actions/runs/${PARENT_RUN_ID}`,
      "--method",
      "GET",
    ]);
  });

  it.each([
    ["active", "in_progress", undefined, false],
    ["active", "completed", "success", false],
    ["active-or-failure", "completed", "failure", true],
    ["active-or-failure", "completed", "success", false],
    ["active-or-success", "completed", "success", true],
    ["active-or-success", "completed", "failure", false],
    ["manual-recovery", "completed", "success", true],
    ["manual-recovery", "completed", "failure", true],
    ["manual-recovery", "completed", "cancelled", false],
  ] as const)("enforces parent policy %s for %s/%s", (policy, status, conclusion, accepted) => {
    const validate = () =>
      validateReleasePublishParentRun({
        ...parentIdentity(),
        releasePublishParentStatePolicy: policy,
        run: parentRun({ status, conclusion }),
      });

    if (accepted) {
      expect(validate).not.toThrow();
    } else {
      expect(validate).toThrow(`state is not allowed by ${policy}`);
    }
  });

  it.each([
    ["active", "waiting", null, true],
    ["active", "completed", "success", false],
    ["active", "waiting", "success", false],
    ["success", "completed", "success", true],
    ["success", "waiting", null, false],
    ["success", "completed", "failure", false],
  ] as const)(
    "enforces writer policy %s for %s/%s",
    (runStatePolicy, status, conclusion, accepted) => {
      const verify = () =>
        verifyReleaseWorkflowRun({
          ...protectedIdentity(),
          runId: RUN_ID,
          runAttempt: "1",
          workflowPath: ".github/workflows/openclaw-release-publish.yml",
          workflowEvent: "workflow_dispatch",
          runStatePolicy,
          runGh: () =>
            JSON.stringify(
              parentRun({
                id: Number(RUN_ID),
                run_attempt: 1,
                path: `.github/workflows/openclaw-release-publish.yml@${FULL_REF}`,
                head_branch: REF,
                status,
                conclusion,
              }),
            ),
        });
      if (accepted) {
        expect(verify()).toMatchObject({ status, conclusion });
      } else {
        expect(verify).toThrow("does not match the authorized workflow identity");
      }
    },
  );

  it("requires the parent state policy with the exact parent run tuple", () => {
    expect(() =>
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
        releasePublishRunId: PARENT_RUN_ID,
        runGh: () =>
          JSON.stringify({
            ref: FULL_REF,
            object: { sha: SHA, type: "commit" },
          }),
      }),
    ).toThrow("run id, attempt, ref, full ref, and parent state policy must be provided together");
  });

  it.each([
    ["wrong parent full ref", "main", "refs/heads/release/2026.8.1"],
    ["untrusted parent ref", "feature/release", "refs/heads/feature/release"],
  ])("rejects %s independently of protected child identity", (_label, parentRef, parentFullRef) => {
    expect(() =>
      validateReleasePublishParentRun({
        ...parentIdentity(),
        releasePublishFullRef: parentFullRef,
        releasePublishParentStatePolicy: "active",
        releasePublishRef: parentRef,
        run: parentRun(),
      }),
    ).toThrow();
  });
});

describe("historical npm preflight tooling", () => {
  const producer = {
    repository: "openclaw/openclaw",
    workflowRef: `openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@${FULL_REF}`,
    workflowSha: SHA,
    runId: RUN_ID,
    runAttempt: "1",
  };
  const expectedProducer = {
    repository: producer.repository,
    workflowFullRef: FULL_REF,
    workflowSha: SHA,
    runId: RUN_ID,
    runAttempt: "1",
  };

  it("distinguishes immutable original ref evidence from legacy unknown provenance", () => {
    expect(
      validateNpmPreflightProducer({ ...expectedProducer, manifest: { version: 2, producer } }),
    ).toEqual({ originalWorkflowRef: producer.workflowRef, provenance: "immutable-manifest" });
    expect(validateNpmPreflightProducer({ ...expectedProducer, manifest: { version: 1 } })).toEqual(
      { originalWorkflowRef: null, provenance: "legacy-unrecorded" },
    );
  });

  it.each([
    undefined,
    { workflowRef: producer.workflowRef.replace("refs/tags/", "refs/heads/") },
    { workflowSha: OTHER_SHA },
    { runId: PARENT_RUN_ID },
    { runAttempt: "2" },
    { repository: "other/repo" },
  ])("rejects incomplete or mismatched immutable producer evidence %j", (override) => {
    const manifest = { version: 2, ...(override && { producer: { ...producer, ...override } }) };
    expect(() => validateNpmPreflightProducer({ ...expectedProducer, manifest })).toThrow();
  });

  function proof(overrides: Record<string, unknown> = {}) {
    const responses: Record<string, unknown> = {
      [`git/ref/tags/${REF}`]: { ref: FULL_REF, object: { sha: SHA, type: "commit" } },
      [`git/matching-refs/heads/${REF}`]: [],
      [`compare/${SHA}...main`]: { status: "ahead" },
      [`compare/${SHA}...${OTHER_SHA}`]: { status: "ahead" },
      ...overrides,
    };
    const runGh = (args: string[]) => {
      const route = args[1]?.replace("repos/openclaw/openclaw/", "");
      if (!route || !(route in responses)) {
        throw new Error("unavailable provenance");
      }
      return JSON.stringify(responses[route]);
    };
    return { ...protectedIdentity(), publisherSha: OTHER_SHA, runGh };
  }

  it("accepts an unchanged historical producer under a distinct descendant publisher", () => {
    const options = proof();
    expect(verifyReleasePreflightToolingIdentity(options)).toMatchObject({
      ref: REF,
      sha: SHA,
      route: "protected-tag",
    });
  });

  it.each([
    ["ambiguous branch", `git/matching-refs/heads/${REF}`, [{ ref: `refs/heads/${REF}` }]],
    ["producer outside main", `compare/${SHA}...main`, { status: "diverged" }],
    ["unrelated publisher", `compare/${SHA}...${OTHER_SHA}`, { status: "diverged" }],
  ])("rejects %s", (_name, route, response) => {
    expect(() => verifyReleasePreflightToolingIdentity(proof({ [route]: response }))).toThrow();
  });

  it.each([
    { publisherSha: "invalid" },
    { workflowFullRef: `refs/heads/${REF}` },
    { workflowSha: OTHER_SHA },
  ])("rejects invalid producer or publisher identity %j", (override) => {
    expect(() => verifyReleasePreflightToolingIdentity({ ...proof(), ...override })).toThrow();
  });
});

const independentProducerRoute = {
  label: "independent producer after FRV rerun",
  workflowPath: ".github/workflows/full-release-artifacts.yml",
  fullRunId: PARENT_RUN_ID,
  fullRunAttempt: "3",
};
const retainedProducerRoute = {
  label: "independent producer retained across transport refs",
  workflowPath: ".github/workflows/full-release-artifacts.yml",
  fullRunId: PARENT_RUN_ID,
  fullRunAttempt: "1",
  retainedTransport: true,
};
const qualificationRoutes = [
  {
    label: "FRV-owned",
    workflowPath: ".github/workflows/full-release-validation.yml",
    fullRunId: RUN_ID,
    fullRunAttempt: "1",
  },
  retainedProducerRoute,
];

function qualificationFixture({
  workflowPath,
  fullRunId,
  fullRunAttempt,
  retainedTransport = false,
  producerRunAttempt = "1",
}: {
  workflowPath: string;
  fullRunId: string;
  fullRunAttempt: string;
  retainedTransport?: boolean;
  producerRunAttempt?: string;
}) {
  const sourceSha = retainedTransport ? SHA : OTHER_SHA;
  const producerRef = retainedTransport ? `release-ci/${SHA.slice(0, 12)}-100` : "main";
  const fullRef = `refs/heads/${producerRef}`;
  const currentRef = `refs/heads/release-ci/${SHA.slice(0, 12)}-200`;
  const retainedSource = {
    runId: RUN_ID,
    candidateSha: SHA,
    workflow: { ref: fullRef, sha: SHA },
    qualificationAdmission: { artifactId: "100" },
  };
  const producer = {
    repository: "openclaw/openclaw",
    workflowRef: `openclaw/openclaw/${workflowPath}@${fullRef}`,
    workflowSha: SHA,
    runId: RUN_ID,
    runAttempt: producerRunAttempt,
    jobId: "999",
    jobName: "Qualify release npm artifacts / Qualify prepared npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const manifest = {
    version: 3,
    releaseSha: sourceSha,
    tarballName: "openclaw.tgz",
    tarballSha256: "c".repeat(64),
    producer,
    preparedBundle: {
      schema: "openclaw.prepared-npm-bundle/v1",
      source: { sha: sourceSha },
      package: { sha256: "c".repeat(64) },
      producer: { repository: producer.repository, workflowSha: SHA },
    },
  };
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: sourceSha },
    producer,
    manifestSha256: "d".repeat(64),
    artifact: {
      id: "555",
      name: `openclaw-npm-preflight-${OTHER_SHA}`,
      digest: "e".repeat(64),
      runId: RUN_ID,
      runAttempt: producerRunAttempt,
    },
  };
  const fullReleaseManifest = {
    workflowName: "Full Release Validation",
    runId: fullRunId,
    runAttempt: fullRunAttempt,
    workflowFullRef: retainedTransport ? currentRef : fullRef,
    targetSha: sourceSha,
    workflowSha: SHA,
    publicationArtifacts: { npmPreflight: qualified },
    ...(retainedTransport
      ? {
          sourceAdmission: {
            ...retainedSource,
            runId: fullRunId,
            workflow: { ref: currentRef, sha: SHA },
          },
          evidenceReuse: {
            policy: "exact-target-full-validation-v1",
            runId: RUN_ID,
            selectedRunId: RUN_ID,
            evidenceSha: SHA,
            changedPaths: [],
            publication: { sourceAdmission: retainedSource },
          },
        }
      : {}),
  };
  const input = {
    manifest,
    repository: producer.repository,
    workflowFullRef: fullRef,
    workflowSha: SHA,
    workflowPath,
    runId: RUN_ID,
    runAttempt: producerRunAttempt,
    fullReleaseManifest,
    fullReleaseRunId: fullRunId,
    fullReleaseRunAttempt: fullRunAttempt,
    manifestSha256: "d".repeat(64),
  };
  const resolutionInput = {
    manifest: fullReleaseManifest,
    repository: producer.repository,
    runId: fullRunId,
    runAttempt: fullRunAttempt,
    sourceSha,
    toolingSha: SHA,
  };
  function reader(jobOverrides = {}, artifactOverrides = {}, runOverrides = {}) {
    const job = {
      id: 999,
      name: producer.jobName,
      run_id: Number(RUN_ID),
      run_attempt: Number(producerRunAttempt),
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      ...jobOverrides,
    };
    return (args: string[]) => {
      const endpoint = args[1];
      if (!endpoint) {
        throw new Error("Expected GitHub API endpoint.");
      }
      if (endpoint.endsWith("/artifacts/555")) {
        return JSON.stringify({
          ...artifactMetadata(qualified.artifact),
          ...artifactOverrides,
        });
      }
      if (endpoint.includes("/jobs?")) {
        return JSON.stringify({ total_count: 1, jobs: [job] });
      }
      if (
        endpoint.endsWith(`/attempts/${producerRunAttempt}`) ||
        endpoint.endsWith(`/actions/runs/${RUN_ID}`)
      ) {
        return JSON.stringify(
          parentRun({
            id: Number(RUN_ID),
            run_attempt: Number(producerRunAttempt),
            path: workflowPath,
            head_branch: producerRef,
            status: "completed",
            conclusion: "success",
            head_repository: { full_name: producer.repository },
            ...runOverrides,
          }),
        );
      }
      throw new Error(`Unexpected proof request: ${endpoint}`);
    };
  }
  return { input, resolutionInput, reader };
}

describe("npm qualification", () => {
  const { input, resolutionInput, reader } = qualificationFixture(independentProducerRoute);
  const { manifest, fullReleaseManifest, workflowPath } = input;
  const { producer } = manifest;
  it.each(qualificationRoutes)("requires exact qualifier and artifact for $label", (route) => {
    const fixture = qualificationFixture(route);
    const runGh = vi.fn(fixture.reader());
    const verify = (
      overrides: Partial<Parameters<typeof verifyNpmPreflightProducer>[0]> = {},
      read = fixture.reader(),
    ) => verifyNpmPreflightProducer({ ...fixture.input, ...overrides, runGh: read });
    expect(resolveFullReleaseNpmPreflight({ ...fixture.resolutionInput, runGh })).toMatchObject({
      producer: { runId: RUN_ID, runAttempt: "1" },
      artifact: { id: 555 },
    });
    expect(runGh.mock.calls.map(([args]) => args[1])).toContain(
      `repos/openclaw/openclaw/actions/runs/${RUN_ID}/attempts/1`,
    );
    expect(verify()).toMatchObject({ provenance: "immutable-manifest" });
    expect(() => verify({}, fixture.reader({ conclusion: "failure" }))).toThrow(
      "completed producer job",
    );
    expect(() => verify({ manifestSha256: "f".repeat(64) })).toThrow(
      "exact full release qualification",
    );
    expect(() => verify({ fullReleaseManifest: undefined })).toThrow("qualified npm preflight");
  });
  it("rejects stale source or attempt and raw-only package evidence", () => {
    expect(() =>
      verifyNpmPreflightProducer({ ...input, manifest: { version: 1 }, runGh: reader() }),
    ).toThrow("qualified version 3");
    expect(() => validateFullReleaseNpmPreflight({ ...resolutionInput, sourceSha: SHA })).toThrow(
      "qualified npm preflight",
    );
    expect(() => validateFullReleaseNpmPreflight({ ...resolutionInput, runAttempt: "2" })).toThrow(
      "qualified npm preflight",
    );
    expect(() =>
      validateNpmPreflightProducer({
        ...input,
        manifest: {
          ...manifest,
          producer: { ...producer, jobName: "Prepare publishable npm package" },
        },
      }),
    ).toThrow("qualification");
  });

  it.each(["root", "candidate", "policy", "transport"])(
    "rejects changed retained %s evidence",
    (mismatch) => {
      const fixture = qualificationFixture(retainedProducerRoute);
      const reuse = fixture.input.fullReleaseManifest.evidenceReuse;
      if (!reuse) {
        throw new Error("Expected retained producer fixture");
      }
      if (mismatch === "root") {
        reuse.selectedRunId = "99999";
      }
      if (mismatch === "candidate") {
        reuse.publication.sourceAdmission.candidateSha = OTHER_SHA;
      }
      if (mismatch === "policy") {
        reuse.policy = "changelog-only-release-v1";
      }
      if (mismatch === "transport") {
        const retainedProducer = fixture.input.manifest.producer;
        retainedProducer.workflowRef = retainedProducer.workflowRef.replace("-100", "-300");
      }
      expect(() =>
        resolveFullReleaseNpmPreflight({ ...fixture.resolutionInput, runGh: fixture.reader() }),
      ).toThrow("qualified npm preflight");
    },
  );

  it.each([
    ["run", "artifact", { runId: "99999" }],
    ["attempt", "artifact", { runAttempt: "2" }],
    ["tooling", "producer", { workflowSha: OTHER_SHA }],
    [
      "workflow",
      "producer",
      { workflowRef: producer.workflowRef.replace(workflowPath, ".github/workflows/ci.yml") },
    ],
    ["repository", "producer", { repository: "other/repository" }],
    [
      "ref",
      "producer",
      { workflowRef: producer.workflowRef.replace("refs/heads/main", "refs/heads/other") },
    ],
  ] as const)("rejects a descriptor detached from its %s binding", (_mismatch, section, patch) => {
    const changed = structuredClone(fullReleaseManifest);
    const descriptor = changed.publicationArtifacts.npmPreflight;
    Object.assign(descriptor[section], patch);
    expect(() =>
      resolveFullReleaseNpmPreflight({ ...resolutionInput, manifest: changed, runGh: reader() }),
    ).toThrow();
  });

  it.each([
    ["run", { id: 777 }, {}],
    ["attempt", { run_attempt: 2 }, {}],
    ["tooling", { head_sha: OTHER_SHA }, {}],
    ["workflow", { path: ".github/workflows/ci.yml" }, {}],
    ["repository", { repository: { full_name: "other/repository" } }, {}],
    ["unfinished", { status: "in_progress", conclusion: null }, {}],
    ["artifact", {}, { workflow_run: { id: 777, head_sha: SHA } }],
  ])("rejects changed live %s evidence", (_mismatch, runOverrides, artifactOverrides) => {
    expect(() =>
      resolveFullReleaseNpmPreflight({
        ...resolutionInput,
        runGh: reader({}, artifactOverrides, runOverrides),
      }),
    ).toThrow();
  });

  it.each(["valid", "archive changed", "manifest changed", "deadline exceeded"])(
    "downloads only the exact qualified archive (%s)",
    async (outcome) => {
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      const tarballBytes = Buffer.from("prepared package bytes");
      const npmLockBytes = Buffer.from(
        `${JSON.stringify({ packages: [{ lock: "x".repeat(3 * 1024 * 1024) }] })}\n`,
      );
      const files = {
        "preflight-manifest.json": manifestBytes,
        [manifest.tarballName]: tarballBytes,
        "dependency-evidence/dependency-evidence-manifest.json": Buffer.from("{}"),
        "dependency-evidence/npm-package-locks.json": npmLockBytes,
        "dependency-evidence/npm-package-locks.md": Buffer.from("# npm package-lock mirrors\n"),
      };
      const zip = new JSZip();
      for (const [name, bytes] of Object.entries(files)) {
        zip.file(name, bytes, { createFolders: false });
      }
      const archive = await zip.generateAsync({
        type: "nodebuffer",
        compression: "STORE",
        platform: "UNIX",
      });
      const selected = structuredClone(fullReleaseManifest);
      const descriptor = selected.publicationArtifacts.npmPreflight;
      descriptor.artifact.digest = digest(archive);
      descriptor.manifestSha256 =
        outcome === "manifest changed" ? "f".repeat(64) : digest(manifestBytes);
      const metadata = {
        ...artifactMetadata(descriptor.artifact),
        size_in_bytes: archive.length,
        expires_at: "2099-10-01T00:00:00Z",
      };
      const delivered = Buffer.from(archive);
      if (outcome === "archive changed") {
        delivered.writeUInt8(delivered.readUInt8(0) ^ 1, 0);
      }
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requests.push(requestUrl);
        return requestUrl.endsWith("/zip")
          ? new Response(new Uint8Array(delivered))
          : Response.json(metadata);
      };
      const root = tempDirs.make("qualified-npm-preflight-");
      const outputDir = join(root, "qualified");
      // Byte assertions must not consume the fixture's transfer deadline.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      onTestFinished(() => clock.mockRestore());
      const downloadOptions = {
        ...resolutionInput,
        manifest: selected,
        outputDir,
        token: "test-artifact-token",
        runGh: reader({}, metadata),
        fetchImpl,
        archivePath: join(root, "555.zip"),
        deadlineMs: Date.now() + (outcome === "deadline exceeded" ? -1 : 10_000),
      };
      const download = downloadFullReleaseNpmPreflight(downloadOptions);
      if (outcome === "valid") {
        await expect(download).resolves.toMatchObject({
          producer: { runId: RUN_ID, runAttempt: "1" },
        });
        for (const [name, bytes] of Object.entries(files)) {
          expect(readFileSync(join(outputDir, name)).equals(bytes), name).toBe(true);
        }
        const retriedDir = join(root, "retried");
        await downloadFullReleaseNpmPreflight({ ...downloadOptions, outputDir: retriedDir });
        expect(readFileSync(join(retriedDir, manifest.tarballName))).toEqual(tarballBytes);
        expect(requests.filter((url) => url.endsWith("/zip"))).toHaveLength(1);
      } else {
        await expect(download).rejects.toThrow(
          outcome === "archive changed"
            ? "digest"
            : outcome === "deadline exceeded"
              ? "deadline exceeded"
              : "qualified descriptor",
        );
        expect(existsSync(outputDir)).toBe(false);
        if (outcome === "deadline exceeded") {
          expect(requests).toHaveLength(0);
        }
      }
    },
  );
});
