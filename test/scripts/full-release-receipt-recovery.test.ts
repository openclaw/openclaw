import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import * as publicationArtifacts from "../../scripts/full-release-artifacts.mjs";
import {
  createPublicationAdmission,
  validatePublicationAdmissionBinding,
} from "../../scripts/full-release-publication-contract.mjs";
import {
  authenticateReceiptRecovery,
  revalidateReceiptRecoveryRuns,
  validateReceiptRecoveryRequest,
  verifyOriginalReceiptQualification,
} from "../../scripts/full-release-receipt-recovery.mjs";
import * as candidateReuse from "../../scripts/lib/full-release-candidate-reuse.mjs";
import { releaseChildReuseSha256 } from "../../scripts/lib/full-release-child-request.mjs";
import * as childReuse from "../../scripts/lib/full-release-child-reuse.mjs";
import {
  RECEIPT_RECOVERY_WORKFLOW,
  retainedPublicationArtifactSource,
} from "../../scripts/lib/release-evidence-identity.mjs";
import { validateFullReleaseNpmPreflight } from "../../scripts/npm-preflight-tooling-identity.mjs";
import { qualificationRequiredChildJobs } from "../../scripts/release-qualification-coverage.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import { recoveryConsumptionFixture } from "./release-evidence-consumption.test-support.js";

function fixture(independentQ = false) {
  const test = recoveryConsumptionFixture(independentQ);
  return { ...test, old: { ...test.direct, client: test.client } };
}

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function aggregateFixture() {
  const test = fixture();
  const originalRead = vi.fn().mockRejectedValue(new Error("original qualification reached"));
  const downloads = vi.spyOn(test.client, "downloadArtifactArchive");
  const authenticate = () =>
    authenticateReceiptRecovery({
      manifest: test.manifest,
      run: test.run,
      client: { ...test.client, getRunAttempt: originalRead },
      artifact: test.aggregateArtifact,
      verifier: undefined,
      expectedRunAttempts: undefined,
    });
  return {
    ...test,
    steps: expectDefined(test.jobs.get("900"), "aggregate jobs")[0]!.steps,
    observations: test.manifest.publicationAdmission.observations,
    observationArtifact: expectDefined(test.metadata.get("444"), "observations"),
    originalRead,
    downloads,
    authenticate,
  };
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
        test.archives.set("444", changed);
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
        expect(test.downloads).toHaveBeenCalledWith(
          expect.objectContaining({
            expected: expect.objectContaining({ artifactId: 444 }),
          }),
        );
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
    expect(verifyChild.mock.calls[0]?.[1]?.policyTargetVersion).toBe(
      recovery.candidateBinding.package.version,
    );
  });

  it.each([false, true])(
    "bounds transfers and verifies adopted child receipts with independent Q=%s",
    async (independentQ) => {
      const test = fixture(independentQ);
      const { old, recovery } = test;
      const selected = expectDefined(recovery.children.normalCi, "normal CI");
      selected.sourceParentRunId = "800";
      selected.workflowRef = "release-ci/earlier-same-candidate";
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
            run: { status: "completed", conclusion: "success" },
            jobs: [],
            receipt: {
              jobs: [
                ...new Set([
                  ...coverage.requiredJobs,
                  ...qualificationRequiredChildJobs({
                    role: request.role,
                    inputs: Object.fromEntries(
                      Object.entries(request.inputs).map(([key, value]) => [key, String(value)]),
                    ),
                    getSource: (path) => readFileSync(path, "utf8"),
                    getCandidateFileNames: old.client.getCandidateFileNames,
                  }),
                ]),
              ].map((name) => ({
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
      const parentJobs = [
        ...(await old.client.getRunAttemptJobs(old.runId)).filter(
          (job) => !dispatches.some((dispatch) => dispatch.name === job.name),
        ),
        ...dispatches,
      ];
      const client = {
        ...old.client,
        validateChildReuse: verifyChild,
        verifyRetainedPublicationArtifacts: verifyPayloads,
        getWorkflowSource: (_sha: string, path: string) => readFileSync(path, "utf8"),
        getRunAttemptJobs: async () => parentJobs,
        getJobLog: async (id: number) => {
          const child = expectDefined(
            dispatches.find((entry) => entry.id === id),
            "dispatch job",
          );
          const witness =
            child.runId === selected.runId
              ? `FRV_CHILD_REUSE_SHA256=${releaseChildReuseSha256(selected)}\n`
              : "";
          return `${witness}TARGET_SHA: ${old.c}\nCI_RELEASE_SCOPE: npm-beta\nhttps://github.com/${old.repository}/actions/runs/${child.runId} (attempt 1)`;
        },
      };
      const adoptedLog = client.getJobLog;
      client.getJobLog = async (id) =>
        (await adoptedLog(id)).replace(/FRV_CHILD_REUSE_SHA256=[a-f0-9]{64}/u, "");
      await expect(verifyOriginalReceiptQualification(recovery, { client })).rejects.toThrow(
        "reuse adoption witness mismatch",
      );
      expect(verifyPayloads).not.toHaveBeenCalled();
      client.getJobLog = adoptedLog;
      await expect(verifyOriginalReceiptQualification(recovery, { client })).rejects.toThrow(
        "publication verification reached",
      );
      expect(verifyPayloads).toHaveBeenCalledOnce();
      expect(verifyPayloads.mock.calls[0]?.[2]).toMatchObject({
        verifyPayloads: true,
        dockerArchiveTimeoutMs: 240_000,
      });

      // Reuse the immutable archives from the consumer fixture; the retained
      // publication owner is covered separately, so isolate recovery's extra inventory.
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
      const binding = recovery.candidateBinding;
      const packageMetadata = expectDefined(test.metadata.get("408"), "plugin package");
      const pluginPackage = {
        ...recovery.publicationArtifacts.pluginNpm,
        artifactId: packageMetadata.id,
        artifactName: packageMetadata.name,
        artifactDigest: packageMetadata.digest,
        artifactSizeBytes: packageMetadata.size_in_bytes,
      };
      const expectedPayloads = [
        {
          kind: "plugin-npm-package",
          artifact: pluginPackage,
          sha256: packageMetadata.digest.slice(7),
        },
        ...(
          [
            ["candidate-shared-image", binding.sharedImage.artifact],
            ["candidate-plugin-registry", binding.prepublishPluginRegistry.artifact],
          ] as const
        ).map(([kind, artifact]) => ({ kind, artifact, sha256: artifact.digest })),
      ];
      const downloads: string[] = [];
      const fetchArtifact = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path.endsWith("/zip")) {
          downloads.push(path.split("/")[6]!);
        }
        return fetchArtifact(input);
      });
      const inventoryClient = {
        ...client,
        getRunArtifacts: vi.fn(test.client.getRunArtifacts),
        getArtifact: vi.fn(test.client.getArtifact),
        downloadArtifactArchive: (
          request: Parameters<typeof test.client.downloadArtifactArchive>[0],
        ) => {
          const expected = request.expected;
          if (!expected || typeof expected !== "object" || !("artifactId" in expected)) {
            throw new Error("Missing expected download identity");
          }
          downloads.push(String(expected.artifactId));
          return test.client.downloadArtifactArchive(request);
        },
      };
      const result = await verifyOriginalReceiptQualification(recovery, {
        client: inventoryClient,
        authenticatedPayloads: expectedPayloads,
      });
      expect(result.children[0]?.sourceParentRunId).toBe("800");
      expect(result.publication.payloads).toEqual(expectedPayloads);
      expect(downloads).toEqual(["407"]);
      expect(inventoryClient.getArtifact.mock.calls.map(([id]) => String(id))).toEqual([
        "407",
        "103",
        "102",
        "101",
      ]);
      // One parent-plan inventory and one prepared-plugin inventory.
      expect(inventoryClient.getRunArtifacts).toHaveBeenCalledTimes(2);
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
        ["408", { digest: "sha256:" + "0".repeat(64) }],
        ["101", { expired: true }],
      ] as const) {
        const metadata = expectDefined(test.metadata.get(id), "retained metadata");
        const original = { ...metadata };
        Object.assign(metadata, changed);
        await expect(
          verifyOriginalReceiptQualification(recovery, {
            client: inventoryClient,
            authenticatedPayloads: expectedPayloads,
          }),
        ).rejects.toThrow("metadata does not match the immutable publication tuple");
        Object.assign(metadata, original);
      }
      downloads.length = 0;
      const produced = await verifyOriginalReceiptQualification(recovery, {
        client: inventoryClient,
      });
      expect(produced.publication.payloads).toEqual(expectedPayloads);
      expect(downloads).toEqual(["407", "408", "103", "102", "101"]);
    },
  );

  it("retains original selection, baselines and Q artifacts under a distinct P admission", () => {
    const { old, source, recovery, manifest, producer } = fixture(true);
    expectDefined(recovery.children.normalCi, "normal CI selection").workflowRef =
      "release-ci/earlier-normal-ci";
    expect(validateReceiptRecoveryRequest(recovery)).toBe(recovery);
    expect(source.candidateSha).toBe(old.c);
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
      sourceSha: old.c,
      toolingSha: producer.sha,
    };
    expect(validateFullReleaseNpmPreflight(expected).producer).toEqual(
      recovery.publicationArtifacts.npmPreflight.producer,
    );
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

  it("rejects historical-plan substitution and incomplete role selection", async () => {
    const { recovery, client } = fixture();
    expect(() => validateReceiptRecoveryRequest({ ...recovery, executionPlan: {} })).toThrow();
    const missing = structuredClone(recovery);
    delete missing.children.normalCi;
    await expect(verifyOriginalReceiptQualification(missing, { client })).rejects.toThrow(
      "exactly the admitted child roles",
    );
  });

  it("rechecks every current producer tuple and rejects a superseding attempt", async () => {
    const { recovery, old } = fixture(true);
    const calls: string[] = [];
    let attempt = 1;
    let childSha = old.q;
    const client = {
      getRun: async (id: string) => {
        calls.push(id);
        return {
          id: Number(id),
          run_attempt: attempt,
          head_sha: id === recovery.children.normalCi?.runId ? childSha : old.q,
          status: "completed",
          conclusion: "success",
        };
      },
    };
    await revalidateReceiptRecoveryRuns(recovery, client);
    expect(new Set(calls).size).toBe(10);
    const normalCi = recovery.children.normalCi;
    if (!normalCi) {
      throw new Error("fixture is missing the normal CI child");
    }
    const waivedRun = normalCi.runId;
    const failedClient = {
      getRun: async (id: string) => ({
        ...(await client.getRun(id)),
        conclusion: id === waivedRun ? "failure" : "success",
      }),
    };
    await expect(revalidateReceiptRecoveryRuns(recovery, failedClient)).rejects.toThrow(
      "current attempt changed",
    );
    childSha = "d".repeat(40);
    const verifiedChildren = [{ runId: waivedRun, conclusion: "failure", workflowSha: childSha }];
    await revalidateReceiptRecoveryRuns(recovery, failedClient, verifiedChildren);
    await expect(
      revalidateReceiptRecoveryRuns(recovery, failedClient, [
        { ...verifiedChildren[0], workflowSha: old.q },
      ]),
    ).rejects.toThrow("current attempt changed");
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
      "node scripts/full-release-receipt-recovery.mjs request",
      "node scripts/full-release-receipt-recovery.mjs admit",
      "node scripts/full-release-receipt-recovery.mjs seal",
    ]);
    expect(
      steps.some((step: { uses?: string }) => step.uses?.includes("full-release-validation")),
    ).toBe(false);
  });
});

describe("receipt recovery CLI", () => {
  it("reaches candidate validation after authenticating admission", () => {
    const directory = mkdtempSync(join(tmpdir(), "receipt-recovery-cli-"));
    try {
      const preload = join(directory, "github.mjs");
      writeFileSync(
        preload,
        `
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        childProcess.execFileSync = (command, args) => {
          if (command !== "gh") throw new Error("Unexpected subprocess");
          const endpoint = args[1];
          if (endpoint.includes("/compare/")) return JSON.stringify({ status: "identical" });
          if (endpoint.endsWith("/actions/runs/900")) return JSON.stringify({
            id: 900, run_attempt: 1, repository: { full_name: "openclaw/openclaw" },
            head_sha: "c".repeat(40), head_branch: "main",
            path: ".github/workflows/full-release-receipt-recovery.yml",
            event: "workflow_dispatch", status: "in_progress", conclusion: null,
            actor: { id: 1, login: "operator", type: "User" },
            triggering_actor: { id: 1, login: "operator", type: "User" }
          });
          if (endpoint.endsWith("/collaborators/operator/permission")) return JSON.stringify({
            permission: "write", user: { id: 1, login: "operator" }
          });
          throw new Error("Unexpected GitHub request: " + endpoint);
        };
        syncBuiltinESMExports();
      `,
      );
      const request = fixture().recovery;
      request.candidateBinding.request.targetSha = "invalid";
      const result = spawnSync(
        process.execPath,
        ["--import", preload, "scripts/full-release-receipt-recovery.mjs", "admit"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15_000,
          env: {
            ...process.env,
            GH_TOKEN: "",
            GITHUB_TOKEN: "",
            RUNNER_TEMP: directory,
            GITHUB_RUN_ID: "900",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_REF: "refs/heads/main",
            GITHUB_SHA: "c".repeat(40),
            GITHUB_WORKFLOW_SHA: "c".repeat(40),
            RECEIPT_RECOVERY_REQUEST: JSON.stringify(request),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Receipt recovery: original candidate and qualification must identify commits",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
