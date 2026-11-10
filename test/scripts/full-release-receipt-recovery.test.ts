import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import * as publicationArtifacts from "../../scripts/full-release-artifacts.mjs";
import {
  createPublicationAdmission,
  createPublicationSourceFact,
  validatePublicationAdmissionBinding,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  authenticateReceiptRecovery,
  RECEIPT_RECOVERY_SCHEMA,
  RECEIPT_RECOVERY_WORKFLOW,
  receiptRecoverySourceRequest,
  revalidateReceiptRecoveryRuns,
  validateReceiptRecoveryRequest,
  verifyOriginalReceiptQualification,
} from "../../scripts/full-release-receipt-recovery.mjs";
import * as qualificationAuthority from "../../scripts/release-qualification-admission.mjs";
import * as toolingAuthority from "../../scripts/release-tooling-identity.mjs";
import * as candidateReuse from "../../scripts/lib/full-release-candidate-reuse.mjs";
import * as childReuse from "../../scripts/lib/full-release-child-reuse.mjs";
import { retainedPublicationArtifactSource } from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import {
  canonicalTestSha256,
  fullReleaseCandidateBindingFixture,
} from "../helpers/full-release-candidate.js";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const roles = [
  "normalCi",
  "pluginPrereleaseIndependent",
  "releaseChecksIndependent",
  "releaseChecksCandidate",
  "pluginPrereleaseCandidate",
];
function fixture() {
  const old = candidatePublicationFixture();
  const producer = { runId: "900", runAttempt: 1, fullRef: "refs/heads/main", sha: "c".repeat(40) };
  const source = createPublicationSourceFact(
    receiptRecoverySourceRequest(old.admission.receipt, producer),
    { packages: [], platforms: [] },
    old.source.projection,
  );
  const baselines = JSON.parse(
    JSON.parse(old.admission.receipt.request.inputs.trusted_workflow_json).laneInputs
      .qualification_baselines_json,
  );
  const recovery = {
    schema: RECEIPT_RECOVERY_SCHEMA,
    requestId: "12345678-1234-4123-8123-123456789abc",
    repository: old.repository,
    qualificationAdmission: old.admission.descriptor,
    originalParent: { runId: old.runId, runAttempt: 1 },
    candidateBinding: fullReleaseCandidateBindingFixture({
      targetSha: old.q,
      toolingSha: old.q,
      releaseProfile: "beta",
      releaseSoak: false,
      upgradeSurvivorBaseline: baselines.upgradeBaseline,
      upgradeSurvivorBaselines: baselines.upgradeSurvivorBaselines.join(" "),
    }),
    children: Object.fromEntries(
      roles.map((role, index) => [
        role,
        {
          runId: String(910 + index),
          runAttempt: 1,
          workflowRef: old.branch,
          sourceParentRunId: old.runId,
          sourceParentAttempt: 1,
        },
      ]),
    ),
    publicationArtifacts: {
      ...old.manifest.publicationArtifacts,
      pluginNpm: { runId: "902", runAttempt: 1 },
    },
  };
  const manifest = {
    ...old.manifest,
    runId: producer.runId,
    workflowSha: producer.sha,
    workflowFullRef: producer.fullRef,
    workflowRef: "main",
    sourceAdmission: source,
    receiptRecovery: recovery,
  };
  return { old, producer, source, recovery, manifest };
}

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function aggregateFixture() {
  const test = fixture();
  const { old, source, producer, recovery, manifest } = test;
  const original = expectDefined(old.manifest.publicationAdmission, "publication admission");
  const observations = { ...original.observations, sourceDigest: source.digest };
  const bytes = makeStoredZip({ "publication-observations.json": JSON.stringify(observations) });
  const observationArtifact = {
    id: 444,
    name: "full-release-publication-observations-900-1",
    digest: "sha256:" + digest(bytes),
    size_in_bytes: bytes.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    created_at: observations.collectionCompletedAt,
    workflow_run: { id: 900, head_sha: producer.sha },
  };
  Object.assign(manifest, {
    runAttempt: 1,
    sourceParentRunAttempt: 1,
    trustedWorkflow: { ref: "main", fullRef: producer.fullRef, sha: producer.sha },
    publicationAdmission: createPublicationAdmission(
      source,
      observations,
      {
        id: "444",
        name: observationArtifact.name,
        digest: observationArtifact.digest,
        sizeInBytes: bytes.length,
      },
      observations.collectionCompletedAt,
      { workflowPath: RECEIPT_RECOVERY_WORKFLOW },
    ),
    childRuns: Object.fromEntries(roles.map((role) => [role, recovery.children[role].runId])),
    retainedPublicationPayloads: [],
    waivers: [],
    advisoryJobs: [],
  });
  delete manifest.executionPlanSha256;
  delete manifest.qualificationCoverage;
  const steps = [
    "Authenticate retained qualification and collect fresh admission",
    "Upload fresh publication observations",
    "Seal receipt-backed aggregate",
    "Upload receipt-backed aggregate",
  ].map((name, index) => ({
    name,
    number: index + 1,
    status: "completed",
    conclusion: "success",
    started_at: observations.collectionCompletedAt,
    completed_at: observations.collectionCompletedAt,
  }));
  const run = {
    ...old.parent,
    id: 900,
    run_attempt: 1,
    head_sha: producer.sha,
    name: "Full Release Receipt Recovery",
    path: RECEIPT_RECOVERY_WORKFLOW,
  };
  // Authority is independently covered; these tests exercise seal ordering and bytes.
  vi.spyOn(toolingAuthority, "verifyReleaseToolingIdentity").mockImplementation(vi.fn());
  vi.spyOn(toolingAuthority, "verifyReleaseWorkflowRun").mockReturnValue(run);
  vi.spyOn(qualificationAuthority, "verifyReleaseQualificationOperator").mockImplementation(vi.fn());
  const originalRead = vi.fn().mockRejectedValue(new Error("original qualification reached"));
  const downloads: string[] = [];
  vi.stubEnv("GH_TOKEN", "fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    downloads.push(url.pathname);
    if (url.pathname.endsWith("/artifacts/444/zip")) return new Response(new Uint8Array(bytes));
    if (url.pathname.endsWith("/artifacts/444")) return Response.json(observationArtifact);
    throw new Error("Unexpected fixture fetch: " + url.pathname);
  }));
  const client = {
    ...old.client,
    getRunAttempt: originalRead,
    getWorkflowSource: (_sha: string, path: string) => readFileSync(path, "utf8"),
    getArtifact: async () => observationArtifact,
    getRunAttemptJobs: async () => [
      {
        name: "Recover original qualification receipts",
        status: "completed",
        conclusion: "success",
        steps,
      },
    ],
  };
  const authenticate = () => authenticateReceiptRecovery({
    manifest,
    run,
    client,
    artifact: { created_at: observations.collectionCompletedAt },
  });
  return { ...test, steps, observations, observationArtifact, originalRead, downloads, authenticate };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("receipt-backed aggregate recovery", () => {
  it.each(["failed seal", "reordered seal", "changed observations", "valid"] as const)(
    "authenticates aggregate seal and observation bytes before original qualification: %s",
    async (fault) => {
      const test = aggregateFixture();
      if (fault === "failed seal") {
        test.steps[2]!.conclusion = "failure";
      }
      if (fault === "reordered seal") {
        test.steps[2]!.number = 1;
      }
      if (fault === "changed observations") {
        // Rebind a real, internally consistent ZIP to different observation content.
        // The byte comparison, not a transport digest failure, must reject it.
        const changed = makeStoredZip({
          "publication-observations.json": JSON.stringify({
            ...test.observations,
            pendingAuthority: ["changed"],
          }),
        });
        test.observationArtifact.digest = "sha256:" + digest(changed);
        test.observationArtifact.size_in_bytes = changed.length;
        Object.assign(test.manifest.publicationAdmission!.binding.artifact, {
          digest: test.observationArtifact.digest,
          sizeInBytes: changed.length,
        });
        vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
          String(input).endsWith("/zip")
            ? new Response(new Uint8Array(changed))
            : Response.json(test.observationArtifact),
        ));
      }
      await expect(test.authenticate()).rejects.toThrow(
        {
          "failed seal": "missing successful Seal receipt-backed aggregate",
          "reordered seal": "aggregate admission ordering changed",
          "changed observations": "fresh observation artifact bytes differ",
          valid: "original qualification reached",
        }[fault],
      );
      expect(test.originalRead).toHaveBeenCalledTimes(fault === "valid" ? 1 : 0);
      if (fault === "valid") {
        expect(test.downloads).toContain("/repos/openclaw/openclaw/actions/artifacts/444/zip");
      }
    },
  );

  it("passes a ten-minute budget to recovery child verification", async () => {
    const { old, recovery } = fixture();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    // Candidate payload validation is separate from the child deadline handoff.
    vi.spyOn(candidateReuse, "verifySealedFullReleaseCandidate").mockImplementation(vi.fn());
    vi.spyOn(childReuse, "validateReusableReleaseChild").mockRejectedValue(
      new Error("unexpected direct child validation"),
    );
    const verifyChild = vi
      .fn<typeof childReuse.validateReusableReleaseChild>()
      .mockRejectedValue(new Error("child verification reached"));
    await expect(
      verifyOriginalReceiptQualification(recovery, {
        client: {
          ...old.client,
          validateChildReuse: verifyChild,
          getWorkflowSource: (_sha: string, path: string) => readFileSync(path, "utf8"),
        },
      }),
    ).rejects.toThrow("child verification reached");
    expect(verifyChild).toHaveBeenCalledOnce();
    expect(verifyChild.mock.calls[0]?.[2]?.deadlineMs).toBe(now + 600_000);
  });

  it("bounds Docker transfers and reconstructs recovery payloads from live metadata", async () => {
    const { old, recovery } = fixture();
    vi.spyOn(candidateReuse, "verifySealedFullReleaseCandidate").mockImplementation(vi.fn());
    const verifyChild = vi
      .fn<typeof childReuse.validateReusableReleaseChild>()
      .mockImplementation(async (_, request) => {
        const coverage = expectDefined(
          old.admission.receipt.coverage.children.find((child) => child.key === request.role),
          "child coverage",
        );
        const selection = {
          ...request,
          runId: expectDefined(recovery.children[request.role], "recovery child").runId,
          runAttempt: 1,
          workflowRef: old.branch,
          displayTitle: "fixture",
          sourceParentRunId: old.runId,
          sourceParentAttempt: 1,
          url: "https://github.com/openclaw/openclaw/actions/runs/910",
          artifact: {
            id: "1",
            name: "fixture",
            digest: "a".repeat(64),
            expiresAt: "2030-01-01",
            sizeInBytes: 1,
          },
          receiptSha256: "a".repeat(64),
          inputs: {},
        };
        return {
          selection,
          run: {},
          jobs: [],
          receipt: {
            jobs: coverage.requiredJobs.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
            })),
          },
        };
      });
    const verifyPayloads = vi
      .spyOn(publicationArtifacts, "verifyRetainedPublicationArtifacts")
      .mockRejectedValue(new Error("publication verification reached"));
    const dispatches = old.admission.receipt.coverage.children.map((child, index) => ({
      id: 10_000 + index,
      name: child.parentJobName,
      status: "completed",
      conclusion: "success",
      runId: expectDefined(recovery.children[child.key], "recovery child").runId,
    }));
    const parentJobs = [...(await old.client.getRunAttemptJobs(old.runId)), ...dispatches];
    const client = {
      ...old.client,
      validateChildReuse: verifyChild,
      getWorkflowSource: (_sha: string, path: string) => readFileSync(path, "utf8"),
      getRunAttemptJobs: async () => parentJobs,
      getJobLog: async (id: number) => {
        const child = expectDefined(dispatches.find((entry) => entry.id === id), "dispatch job");
        return `TARGET_SHA: ${old.q}\nCI_RELEASE_SCOPE: npm-beta\nhttps://github.com/${old.repository}/actions/runs/${child.runId} (attempt 1)`;
      },
    };
    await expect(verifyOriginalReceiptQualification(recovery, { client })).rejects.toThrow(
      "publication verification reached",
    );
    expect(verifyPayloads).toHaveBeenCalledOnce();
    expect(verifyPayloads.mock.calls[0]?.[2]).toMatchObject({
      verifyPayloads: true,
      dockerArchiveTimeoutMs: 240_000,
    });

    // The retained-publication owner has separate inventory tests. Keep its
    // result empty here so only recovery's additional plugin/candidate records
    // are under test; candidate and child qualification are prerequisites above.
    verifyPayloads.mockImplementation(async () => ({
      outputs: {
        publication_artifacts_reused: "true",
        prepared_bundle_json: "",
        qualified_preflight_bundle_json: "",
        npm_run_id: old.runId,
        npm_run_attempt: "1",
        descriptor_json: "",
      },
      payloads: [],
    }));
    vi.spyOn(qualificationAuthority, "revalidateQualificationAdmissionAuthority").mockImplementation(
      vi.fn(),
    );
    vi.stubEnv("GH_TOKEN", "fixture-token");
    const pluginProducer = {
      repository: old.repository,
      runId: 902,
      runAttempt: 1,
      workflowPath: ".github/workflows/plugin-npm-release.yml",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: old.branch,
      workflowSha: old.q,
    };
    const pluginPackageBytes = makeStoredZip({ "plugin.tgz": "retained plugin package" });
    const pluginPackage = {
      ...pluginProducer,
      artifactId: 905,
      artifactName: "plugin-npm-package-codex-2026.8.28-beta.1-npm-oidc-902-1",
      artifactDigest: "sha256:" + digest(pluginPackageBytes),
      artifactSizeBytes: pluginPackageBytes.length,
    };
    const pluginManifest = {
      schema: "openclaw.plugin-npm-prepared/v1",
      runtimeQualification: "packed-runtime-v1",
      sourceSha: old.q,
      npmDistTag: "default",
      selectionMode: "all-publishable",
      publisherPolicySha256: digest(readFileSync(pluginProducer.workflowPath)),
      producer: pluginProducer,
      packages: [
        {
          extensionId: "codex",
          packageDir: "extensions/codex",
          packageName: "@openclaw/codex",
          version: "2026.8.28-beta.1",
          channel: "beta",
          publishTag: "beta",
          installNpmSpec: "@openclaw/codex@2026.8.28-beta.1",
          route: "npm-oidc",
          artifact: pluginPackage,
        },
      ],
    };
    const manifestBytes = makeStoredZip({
      "plugin-npm-prepared.json": JSON.stringify(pluginManifest),
    });
    Object.assign(recovery.publicationArtifacts.pluginNpm, pluginProducer, {
      artifactId: 904,
      artifactName: "plugin-npm-prepared-fixture",
      artifactDigest: "sha256:" + digest(manifestBytes),
      artifactSizeBytes: manifestBytes.length,
    });
    const binding = recovery.candidateBinding;
    const packageBytes = makeStoredZip({
      [binding.package.fileName]: "qualified candidate tgz",
      "package-candidate.json": "{}",
    });
    binding.package.packageSha256 = digest("qualified candidate tgz");
    const candidateBytes = [Buffer.from("shared image"), Buffer.from("plugin registry"), packageBytes];
    const candidateArtifacts = [
      binding.sharedImage.artifact,
      binding.prepublishPluginRegistry.artifact,
      binding.package.artifact,
    ];
    const metadata = new Map<string, Record<string, unknown>>();
    const archives = new Map<string, Buffer>([
      ["904", manifestBytes],
      ["905", pluginPackageBytes],
    ]);
    const addMetadata = (id: string, name: string, runId: number, bytes: Buffer) => {
      metadata.set(id, {
        id: Number(id),
        name,
        digest: "sha256:" + digest(bytes),
        size_in_bytes: bytes.length,
        expired: false,
        expires_at: "2099-01-01T00:00:00Z",
        workflow_run: { id: runId, head_sha: old.q },
      });
    };
    addMetadata("904", recovery.publicationArtifacts.pluginNpm.artifactName, 902, manifestBytes);
    addMetadata("905", pluginPackage.artifactName, 902, pluginPackageBytes);
    candidateArtifacts.forEach((artifact, index) => {
      const bytes = candidateBytes[index]!;
      Object.assign(artifact, { digest: digest(bytes), expiresAt: "2099-01-01T00:00:00Z" });
      addMetadata(artifact.id, artifact.name, Number(artifact.runId), bytes);
      archives.set(artifact.id, bytes);
    });
    binding.sharedImage.packageSha256 = binding.package.packageSha256;
    const {
      evidenceArtifact: _evidence,
      manifestSha256: _digest,
      schema: _schema,
      ...fields
    } = binding;
    binding.manifestSha256 = canonicalTestSha256({
      schema: "openclaw.full-release-candidate/v2",
      ...fields,
    });
    const downloads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const id = expectDefined(path.split("/")[6], "artifact URL");
      if (!path.endsWith("/zip")) return Response.json(metadata.get(id));
      downloads.push(id);
      return new Response(new Uint8Array(expectDefined(archives.get(id), "archive")));
    }));
    const inventoryClient = {
      ...client,
      getRunArtifacts: vi.fn(async () => [expectDefined(metadata.get("905"), "plugin metadata")]),
      getArtifact: vi.fn(async (id: string | number) =>
        expectDefined(metadata.get(String(id)), "metadata"),
      ),
      getRun: async (id: string) => ({
        id: Number(id),
        run_attempt: 1,
        head_sha: old.q,
        status: "completed",
        conclusion: "success",
      }),
    };
    const expectedPayloads = [
      { kind: "plugin-npm-package", artifact: pluginPackage, sha256: digest(pluginPackageBytes) },
      {
        kind: "candidate-shared-image",
        artifact: binding.sharedImage.artifact,
        sha256: digest(candidateBytes[0]!),
      },
      {
        kind: "candidate-plugin-registry",
        artifact: binding.prepublishPluginRegistry.artifact,
        sha256: digest(candidateBytes[1]!),
      },
    ];
    const result = await verifyOriginalReceiptQualification(recovery, {
      client: inventoryClient,
      authenticatedPayloads: expectedPayloads,
    });
    expect(result.publication.payloads).toEqual(expectedPayloads);
    expect(downloads).toEqual(["904"]);
    expect(inventoryClient.getArtifact.mock.calls.map(([id]) => String(id))).toEqual([
      "904",
      "103",
      "102",
      "101",
    ]);
    expect(inventoryClient.getRunArtifacts).toHaveBeenCalledOnce();
    for (const authenticatedPayloads of [
      expectedPayloads.slice(1),
      [...expectedPayloads, expectedPayloads[0]],
      expectedPayloads.map((payload) => ({ ...payload, sha256: "0".repeat(64) })),
    ]) {
      await expect(
        verifyOriginalReceiptQualification(recovery, {
          client: inventoryClient,
          authenticatedPayloads,
        }),
      ).rejects.toThrow("original publication payload inventory changed");
    }
    for (const [id, changed] of [
      ["905", { digest: "sha256:" + "0".repeat(64) }],
      ["101", { expired: true }],
    ] as const) {
      const packageMetadata = expectDefined(metadata.get(id), "retained metadata");
      const original = { ...packageMetadata };
      Object.assign(packageMetadata, changed);
      await expect(
        verifyOriginalReceiptQualification(recovery, {
          client: inventoryClient,
          authenticatedPayloads: expectedPayloads,
        }),
      ).rejects.toThrow("metadata does not match the immutable publication tuple");
      Object.assign(packageMetadata, original);
    }
    downloads.length = 0;
    const produced = await verifyOriginalReceiptQualification(recovery, { client: inventoryClient });
    expect(produced.publication.payloads).toEqual(expectedPayloads);
    expect(downloads).toEqual(["904", "905", "103", "102", "101"]);
  });

  it("retains original selection, baselines and Q artifacts under a distinct P admission", () => {
    const { old, source, recovery, manifest, producer } = fixture();
    expect(validateReceiptRecoveryRequest(recovery)).toBe(recovery);
    expect(source.candidateSha).toBe(old.q);
    expect(source.workflow).toEqual({ ref: producer.fullRef, sha: producer.sha });
    expect(source.publicationSelection).toEqual(old.source.publicationSelection);
    expect(source.coverage).toEqual(old.source.coverage);
    expect(source.qualificationAdmission).toBeUndefined();
    expect(retainedPublicationArtifactSource(manifest)?.workflow.sha).toBe(old.q);
    const expected = {
      manifest,
      repository: old.repository,
      runId: producer.runId,
      runAttempt: 1,
      sourceSha: old.q,
      toolingSha: producer.sha,
    };
    expect(validateFullReleaseNpmPreflight(expected).producer).toEqual(old.npmQualified.producer);
    expect(() =>
      validateFullReleaseNpmPreflight({ ...expected, sourceSha: "d".repeat(40) }),
    ).toThrow();
  });

  it("requires a new explicit admission path and never loosens the historical default", () => {
    const { old, source } = fixture();
    const original = expectDefined(old.manifest.publicationAdmission, "admission");
    const observations = { ...original.observations, sourceDigest: source.digest };
    const admission = createPublicationAdmission(
      source,
      observations,
      { ...original.binding.artifact, name: "full-release-publication-observations-900-1" },
      observations.collectionCompletedAt,
      { workflowPath: RECEIPT_RECOVERY_WORKFLOW },
    );
    const record = {
      sourceAdmissionContract: "1",
      sourceAdmission: source,
      publicationAdmissionContract: "1",
      publicationAdmission: admission,
    };
    expect(() => validatePublicationAdmissionBinding(record)).toThrow();
    expect(
      validatePublicationAdmissionBinding(record, { workflowPath: RECEIPT_RECOVERY_WORKFLOW }),
    ).toEqual(admission);
    expect(() =>
      createPublicationAdmission(
        source,
        observations,
        admission.binding.artifact,
        observations.collectionCompletedAt,
        { workflowPath: ".github/workflows/ci.yml" },
      ),
    ).toThrow();
  });

  it.each(["parent identity", "required jobs"])(
    "rejects changed original %s through the receipt owner",
    async (fault) => {
      const { old, recovery } = fixture();
      const callsBefore = old.admission.calls.length;
      const client = {
        ...old.client,
        getRunAttempt: (id: string, attempt: number) => {
          expect([id, attempt]).toEqual([old.runId, 1]);
          return { ...old.parent, head_sha: fault === "parent identity" ? "f".repeat(40) : old.q };
        },
        getRunAttemptJobs: async () => [],
      };
      await expect(verifyOriginalReceiptQualification(recovery, { client })).rejects.toThrow(
        fault === "parent identity"
          ? "original parent differs"
          : "required job did not succeed exactly once",
      );
      // This is the real admission verifier and immutable archive, not a supplied
      // successful strict-verifier result. Failure occurs before candidate download.
      expect(old.admission.calls.slice(callsBefore)).toContain(
        `repos/${old.repository}/actions/artifacts/70`,
      );
    },
  );

  it("rejects historical-plan substitution and incomplete role selection", () => {
    const { recovery } = fixture();
    expect(() => validateReceiptRecoveryRequest({ ...recovery, executionPlan: {} })).toThrow();
    const missing = structuredClone(recovery);
    delete missing.children.normalCi;
    expect(() => validateReceiptRecoveryRequest(missing)).toThrow();
  });

  it("rechecks every current producer tuple and rejects a superseding attempt", async () => {
    const { recovery, old } = fixture();
    const calls: string[] = [];
    let attempt = 1;
    const client = {
      getRun: async (id: string) => {
        calls.push(id);
        return {
          id: Number(id),
          run_attempt: attempt,
          head_sha: old.q,
          status: "completed",
          conclusion: "success",
        };
      },
    };
    await revalidateReceiptRecoveryRuns(recovery, client);
    expect(new Set(calls).size).toBe(8);
    attempt = 2;
    await expect(revalidateReceiptRecoveryRuns(recovery, client)).rejects.toThrow(
      "current attempt changed",
    );
  });

  it("exposes only a read-authorized aggregate workflow with no qualification fallback", () => {
    const workflow = parse(readFileSync(RECEIPT_RECOVERY_WORKFLOW, "utf8"));
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["aggregate"]);
    const steps = workflow.jobs.aggregate.steps;
    expect(
      steps
        .filter((step: { run?: string }) => step.run?.includes("full-release-receipt-recovery.mjs"))
        .map((step: { run: string }) => step.run),
    ).toEqual([
      "node scripts/full-release-receipt-recovery.mjs admit",
      "node scripts/full-release-receipt-recovery.mjs seal",
    ]);
    expect(
      steps.some((step: { uses?: string }) => step.uses?.includes("full-release-validation")),
    ).toBe(false);
  });
});
