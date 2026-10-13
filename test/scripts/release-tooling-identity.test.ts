import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("rejects a raw commit SHA as the workflow transport ref", () => {
    expect(() =>
      resolveReleaseToolingIdentity({
        workflowContract: "2",
        workflowFullRef: `refs/heads/${SHA}`,
        workflowRef: SHA,
        workflowSha: SHA,
      }),
    ).toThrow("workflow ref is not a trusted direct, release-ci, or protected-tag route");
  });

  it.each([["2", "release/2026.8.1", "refs/heads/release/2026.8.1"]])(
    "derives contract %s identity for safe direct workflow ref %s",
    (contract, ref, fullRef) => {
      expect(
        resolveReleaseToolingIdentity({
          workflowContract: contract,
          workflowFullRef: fullRef,
          workflowRef: ref,
          workflowSha: SHA,
        }),
      ).toEqual({ fullRef, ref, sha: SHA });
    },
  );

  it("rejects retired Tideclaw tooling even when prevalidated", () => {
    const workflowRef = "tideclaw/alpha/2026-08-21-1200Z";
    const identity = {
      workflowRef,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowSha: SHA,
    };
    expect(() => resolveReleaseToolingIdentity({ ...identity, workflowContract: "2" })).toThrow(
      "Alpha releases are retired;",
    );
    expect(() =>
      validateReleaseToolingIdentity({ ...identity, allowPrevalidatedRef: true }),
    ).toThrow("Alpha releases are retired;");
  });

  it("rejects unsupported contract 3 even with explicit identity", () => {
    expect(() =>
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: SHA,
        }),
        workflowContract: "3",
        workflowFullRef: "refs/heads/main",
        workflowRef: "main",
        workflowSha: SHA,
      }),
    ).toThrow("release tooling contract 3 is not supported");
  });

  it.each([
    [
      "protected tag",
      {
        workflowContract: "2",
        workflowFullRef: FULL_REF,
        workflowRef: REF,
      },
    ],
  ])("requires explicit identity for $0", (_label, overrides) => {
    const { workflowContract, workflowFullRef } = overrides;
    const workflowRef = "workflowRef" in overrides ? overrides.workflowRef : "main";
    expect(() =>
      resolveReleaseToolingIdentity({
        workflowContract,
        workflowFullRef,
        workflowRef,
        workflowSha: SHA,
      }),
    ).toThrow(/requires explicit trusted workflow identity|require explicit trusted workflow/u);
  });

  it("accepts explicit main identity for a matching release-ci workflow", () => {
    const releaseCiRef = `release-ci/${SHA.slice(0, 12)}-123`;
    expect(
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: SHA,
        }),
        workflowContract: "2",
        workflowFullRef: `refs/heads/${releaseCiRef}`,
        workflowRef: releaseCiRef,
        workflowSha: SHA,
      }),
    ).toEqual({ ref: "main", fullRef: "refs/heads/main", sha: SHA });
  });

  it("rejects a release-ci transport whose prefix does not match the Tooling SHA", () => {
    const releaseCiRef = `release-ci/${OTHER_SHA.slice(0, 12)}-123`;
    expect(() =>
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          fullRef: "refs/heads/main",
          ref: "main",
          sha: SHA,
        }),
        workflowContract: "2",
        workflowFullRef: `refs/heads/${releaseCiRef}`,
        workflowRef: releaseCiRef,
        workflowSha: SHA,
      }),
    ).toThrow("release-ci workflow ref does not match the workflow SHA");
  });

  it("loads candidate qualification admission without deadlocking the CLI module cycle", () => {
    const releaseCiRef = `release-ci/${SHA.slice(0, 12)}-123`;
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/release-tooling-identity.mjs"),
        "resolve",
        "--qualification-admission-json",
        "{}",
        "--qualification-inputs-json",
        "{}",
        "--candidate-sha",
        SHA,
        "--repository",
        "openclaw/openclaw",
        "--workflow-contract",
        "2",
        "--workflow-ref",
        releaseCiRef,
        "--workflow-full-ref",
        `refs/heads/${releaseCiRef}`,
        "--workflow-sha",
        SHA,
        "--requested-identity-json",
        JSON.stringify({ ref: releaseCiRef, fullRef: `refs/heads/${releaseCiRef}`, sha: SHA }),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid admission descriptor fields");
    expect(result.stderr).not.toContain("unsettled top-level await");
  });

  it("rejects a candidate SHA substituted for the release-ci Tooling SHA", () => {
    const releaseCiRef = `release-ci/${SHA.slice(0, 12)}-123`;
    expect(() =>
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          fullRef: "refs/heads/main",
          ref: "main",
          sha: OTHER_SHA,
        }),
        workflowContract: "2",
        workflowFullRef: `refs/heads/${releaseCiRef}`,
        workflowRef: releaseCiRef,
        workflowSha: SHA,
      }),
    ).toThrow("release-ci workflow identity must be trusted main");
  });

  it("rejects explicit identity that does not match a direct workflow", () => {
    expect(() =>
      resolveReleaseToolingIdentity({
        requestedIdentityJson: JSON.stringify({
          ref: "main",
          fullRef: "refs/heads/main",
          sha: OTHER_SHA,
        }),
        workflowContract: "2",
        workflowFullRef: "refs/heads/main",
        workflowRef: "main",
        workflowSha: SHA,
      }),
    ).toThrow("must match the executing workflow ref and SHA");
  });

  it.each([
    [
      "deleted tag",
      {
        runGh: () => {
          throw new Error("HTTP 404");
        },
      },
      "missing or unreadable",
    ],
  ])("rejects $0", (_label, overrides, expectedError) => {
    expect(() =>
      verifyReleaseToolingIdentity({
        ...protectedIdentity(),
        ...overrides,
      }),
    ).toThrow(expectedError);
  });

  it("rejects a prevalidated branch moved after approval", () => {
    expect(() =>
      verifyReleaseToolingIdentity({
        allowPrevalidatedRef: true,
        repository: "openclaw/openclaw",
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
    const calls: string[][] = [];
    const runGh = vi.fn((args: string[]) => {
      calls.push(args);
      if (args[1]?.includes("/git/ref/tags/")) {
        return JSON.stringify({
          ref: FULL_REF,
          object: { sha: SHA, type: "commit" },
        });
      }
      return JSON.stringify({
        id: Number(PARENT_RUN_ID),
        run_attempt: Number(PARENT_RUN_ATTEMPT),
        repository: { full_name: "openclaw/openclaw" },
        path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: SHA,
        status: "in_progress",
        conclusion: null,
      });
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
    expect(PARENT_RUN_ID).not.toBe(RUN_ID);
    expect(calls).toContainEqual([
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
  ] as const)(
    "enforces parent state policy %s for %s/%s",
    (releasePublishParentStatePolicy, status, conclusion, accepted) => {
      const validate = () =>
        validateReleasePublishParentRun({
          identity: { ref: REF, fullRef: FULL_REF, sha: SHA },
          releasePublishFullRef: "refs/heads/main",
          releasePublishParentStatePolicy,
          releasePublishRef: "main",
          releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
          releasePublishRunId: PARENT_RUN_ID,
          repository: "openclaw/openclaw",
          run: {
            id: Number(PARENT_RUN_ID),
            run_attempt: Number(PARENT_RUN_ATTEMPT),
            repository: { full_name: "openclaw/openclaw" },
            path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: SHA,
            status,
            conclusion,
          },
        });

      if (accepted) {
        expect(validate).not.toThrow();
      } else {
        expect(validate).toThrow(`state is not allowed by ${releasePublishParentStatePolicy}`);
      }
    },
  );

  it.each([
    ["active", "waiting", null, true],
    ["active", "completed", "success", false],
    ["active", "waiting", "success", false],
    ["success", "completed", "success", true],
    ["success", "waiting", null, false],
    ["success", "completed", "failure", false],
  ] as const)(
    "enforces writer state policy %s for %s/%s",
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
            JSON.stringify({
              id: Number(RUN_ID),
              run_attempt: 1,
              repository: { full_name: "openclaw/openclaw" },
              path: `.github/workflows/openclaw-release-publish.yml@${FULL_REF}`,
              event: "workflow_dispatch",
              head_branch: REF,
              head_sha: SHA,
              status,
              conclusion,
            }),
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
        identity: { ref: REF, fullRef: FULL_REF, sha: SHA },
        releasePublishFullRef: parentFullRef,
        releasePublishParentStatePolicy: "active",
        releasePublishRef: parentRef,
        releasePublishRunAttempt: PARENT_RUN_ATTEMPT,
        releasePublishRunId: PARENT_RUN_ID,
        repository: "openclaw/openclaw",
        run: {
          id: Number(PARENT_RUN_ID),
          run_attempt: Number(PARENT_RUN_ATTEMPT),
          repository: { full_name: "openclaw/openclaw" },
          path: ".github/workflows/openclaw-release-publish.yml@refs/heads/main",
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: SHA,
          status: "in_progress",
          conclusion: null,
        },
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
    { version: 2 },
    {
      version: 2,
      producer: {
        ...producer,
        workflowRef: producer.workflowRef.replace("refs/tags/", "refs/heads/"),
      },
    },
    { version: 2, producer: { ...producer, workflowSha: OTHER_SHA } },
    { version: 2, producer: { ...producer, runId: PARENT_RUN_ID } },
    { version: 2, producer: { ...producer, runAttempt: "2" } },
    { version: 2, producer: { ...producer, repository: "other/repo" } },
  ])("rejects incomplete or mismatched immutable producer evidence %j", (manifest) => {
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
    const runGh = vi.fn((args: string[]) => {
      const route = args[1]?.replace("repos/openclaw/openclaw/", "");
      if (!route || !(route in responses)) {
        throw new Error("unavailable provenance");
      }
      return JSON.stringify(responses[route]);
    });
    return { ...protectedIdentity(), publisherSha: OTHER_SHA, runGh };
  }

  it("accepts an unchanged historical producer under a distinct descendant publisher", () => {
    const options = proof();
    expect(verifyReleasePreflightToolingIdentity(options)).toMatchObject({
      ref: REF,
      sha: SHA,
      route: "protected-tag",
    });
    expect(options.runGh.mock.calls.map(([args]) => args[1])).toEqual([
      `repos/openclaw/openclaw/git/ref/tags/${REF}`,
      `repos/openclaw/openclaw/git/matching-refs/heads/${REF}`,
      `repos/openclaw/openclaw/compare/${SHA}...main`,
      `repos/openclaw/openclaw/compare/${SHA}...${OTHER_SHA}`,
    ]);
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
    runAttempt: 1,
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
            runAttempt: Number(fullRunAttempt),
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
          id: 555,
          name: qualified.artifact.name,
          digest: `sha256:${qualified.artifact.digest}`,
          expired: false,
          workflow_run: { id: Number(RUN_ID), head_sha: SHA },
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
        return JSON.stringify({
          id: Number(RUN_ID),
          run_attempt: Number(producerRunAttempt),
          head_sha: SHA,
          path: workflowPath,
          head_branch: producerRef,
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          repository: { full_name: producer.repository },
          head_repository: { full_name: producer.repository },
          ...runOverrides,
        });
      }
      throw new Error(`Unexpected proof request: ${endpoint}`);
    };
  }
  return {
    producer,
    manifest,
    qualified,
    fullReleaseManifest,
    input,
    resolutionInput,
    reader,
    workflowPath,
    fullRunId,
    fullRunAttempt,
  };
}

describe("npm qualification", () => {
  const {
    producer,
    manifest,
    qualified,
    fullReleaseManifest,
    input,
    resolutionInput,
    reader,
    workflowPath,
    fullRunId,
    fullRunAttempt,
  } = qualificationFixture(independentProducerRoute);
  it.each(qualificationRoutes)("requires exact qualifier and artifact for $label", (route) => {
    const {
      input: routeInput,
      resolutionInput: routeResolutionInput,
      reader: routeReader,
    } = qualificationFixture(route);
    const runGh = vi.fn(routeReader());
    expect(resolveFullReleaseNpmPreflight({ ...routeResolutionInput, runGh })).toMatchObject({
      producer: { runId: RUN_ID, runAttempt: "1" },
      artifact: { id: 555 },
    });
    expect(runGh.mock.calls.map(([args]) => args[1])).toContain(
      `repos/openclaw/openclaw/actions/runs/${RUN_ID}/attempts/1`,
    );
    expect(verifyNpmPreflightProducer({ ...routeInput, runGh: routeReader() })).toMatchObject({
      provenance: "immutable-manifest",
    });
    expect(() =>
      verifyNpmPreflightProducer({ ...routeInput, runGh: routeReader({ conclusion: "failure" }) }),
    ).toThrow("completed producer job");
    expect(() =>
      verifyNpmPreflightProducer({
        ...routeInput,
        manifestSha256: "f".repeat(64),
        runGh: routeReader(),
      }),
    ).toThrow("exact full release qualification");
    expect(() =>
      verifyNpmPreflightProducer({
        ...routeInput,
        fullReleaseManifest: undefined,
        runGh: routeReader(),
      }),
    ).toThrow("qualified npm preflight");
  });
  it("rejects stale source or attempt and raw-only package evidence", () => {
    expect(() =>
      verifyNpmPreflightProducer({ ...input, manifest: { version: 1 }, runGh: reader() }),
    ).toThrow("qualified version 3");
    const expected = {
      manifest: fullReleaseManifest,
      runId: fullRunId,
      runAttempt: fullRunAttempt,
      sourceSha: OTHER_SHA,
      toolingSha: SHA,
    };
    expect(() => validateFullReleaseNpmPreflight({ ...expected, sourceSha: SHA })).toThrow(
      "qualified npm preflight",
    );
    expect(() => validateFullReleaseNpmPreflight({ ...expected, runAttempt: "2" })).toThrow(
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
    "rejects retained npm evidence with a changed %s binding",
    (mismatch) => {
      const fixture = qualificationFixture(retainedProducerRoute);
      const reuse = fixture.fullReleaseManifest.evidenceReuse;
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
        fixture.producer.workflowRef = fixture.producer.workflowRef.replace("-100", "-300");
      }
      expect(() =>
        resolveFullReleaseNpmPreflight({ ...fixture.resolutionInput, runGh: fixture.reader() }),
      ).toThrow("qualified npm preflight");
    },
  );

  it.each(["run", "attempt", "tooling", "workflow", "repository", "ref"])(
    "rejects a descriptor detached from its %s binding",
    (mismatch) => {
      const changed = structuredClone(fullReleaseManifest);
      const descriptor = changed.publicationArtifacts.npmPreflight;
      if (mismatch === "run") {
        descriptor.artifact.runId = "99999";
      }
      if (mismatch === "attempt") {
        descriptor.artifact.runAttempt = "2";
      }
      if (mismatch === "tooling") {
        descriptor.producer.workflowSha = OTHER_SHA;
      }
      if (mismatch === "workflow") {
        descriptor.producer.workflowRef = producer.workflowRef.replace(
          workflowPath,
          ".github/workflows/ci.yml",
        );
      }
      if (mismatch === "repository") {
        descriptor.producer.repository = "other/repository";
      }
      if (mismatch === "ref") {
        descriptor.producer.workflowRef = producer.workflowRef.replace(
          "refs/heads/main",
          "refs/heads/other",
        );
      }
      expect(() =>
        resolveFullReleaseNpmPreflight({ ...resolutionInput, manifest: changed, runGh: reader() }),
      ).toThrow();
    },
  );

  it.each([
    ["run", { id: 777 }, {}],
    ["attempt", { run_attempt: 2 }, {}],
    ["tooling", { head_sha: OTHER_SHA }, {}],
    ["workflow", { path: ".github/workflows/ci.yml" }, {}],
    ["repository", { repository: { full_name: "other/repository" } }, {}],
    ["unfinished", { status: "in_progress", conclusion: null }, {}],
    ["artifact", {}, { workflow_run: { id: 777, head_sha: SHA } }],
  ])(
    "rejects changed live %s evidence before downloading package bytes",
    (_mismatch, runOverrides, artifactOverrides) => {
      expect(() =>
        resolveFullReleaseNpmPreflight({
          ...resolutionInput,
          runGh: reader({}, artifactOverrides, runOverrides),
        }),
      ).toThrow();
    },
  );

  it.each(["valid", "archive changed", "manifest changed", "deadline exceeded"])(
    "downloads only the exact qualified archive (%s)",
    async (outcome) => {
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      const tarballBytes = Buffer.from("prepared package bytes");
      const npmLockBytes = Buffer.from(
        `${JSON.stringify({ packages: [{ lock: "x".repeat(3 * 1024 * 1024) }] })}\n`,
      );
      const zip = new JSZip();
      zip.file("preflight-manifest.json", manifestBytes);
      zip.file(manifest.tarballName, tarballBytes);
      zip.file("dependency-evidence/dependency-evidence-manifest.json", "{}", {
        createFolders: false,
      });
      zip.file("dependency-evidence/npm-package-locks.json", npmLockBytes, {
        createFolders: false,
      });
      zip.file("dependency-evidence/npm-package-locks.md", "# npm package-lock mirrors\n", {
        createFolders: false,
      });
      const archive = await zip.generateAsync({
        type: "nodebuffer",
        compression: "STORE",
        platform: "UNIX",
      });
      const selected = structuredClone(fullReleaseManifest);
      selected.publicationArtifacts.npmPreflight.artifact.digest = createHash("sha256")
        .update(archive)
        .digest("hex");
      selected.publicationArtifacts.npmPreflight.manifestSha256 =
        outcome === "manifest changed"
          ? "f".repeat(64)
          : createHash("sha256").update(manifestBytes).digest("hex");
      const metadata = {
        id: 555,
        name: qualified.artifact.name,
        digest: `sha256:${selected.publicationArtifacts.npmPreflight.artifact.digest}`,
        size_in_bytes: archive.length,
        expired: false,
        expires_at: "2099-10-01T00:00:00Z",
        workflow_run: { id: Number(RUN_ID), head_sha: SHA },
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
        expect(readFileSync(join(outputDir, "preflight-manifest.json"))).toEqual(manifestBytes);
        expect(readFileSync(join(outputDir, manifest.tarballName))).toEqual(tarballBytes);
        expect(
          readFileSync(
            join(outputDir, "dependency-evidence/dependency-evidence-manifest.json"),
            "utf8",
          ),
        ).toBe("{}");
        const retriedDir = join(root, "retried");
        await downloadFullReleaseNpmPreflight({ ...downloadOptions, outputDir: retriedDir });
        expect(readFileSync(join(retriedDir, manifest.tarballName))).toEqual(tarballBytes);
        expect(requests.filter((url) => url.endsWith("/zip"))).toHaveLength(1);
        expect(readFileSync(join(outputDir, "dependency-evidence/npm-package-locks.json"))).toEqual(
          npmLockBytes,
        );
        expect(
          readFileSync(join(outputDir, "dependency-evidence/npm-package-locks.md"), "utf8"),
        ).toBe("# npm package-lock mirrors\n");
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
