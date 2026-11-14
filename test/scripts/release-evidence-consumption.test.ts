import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateReceiptRecovery,
  verifyOriginalReceiptQualification,
} from "../../scripts/full-release-receipt-recovery.mjs";
import * as preflightTransport from "../../scripts/lib/release-publish-preflight-evidence.mts";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import { runReleasePublishPreflight } from "../../scripts/release-publish-preflight.mts";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import {
  recoveryConsumptionFixture,
  consumptionOptions,
} from "./release-evidence-consumption.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("release evidence consumption", () => {
  it("accepts authenticated recovery of frozen Q qualification for publication", async () => {
    const f = recoveryConsumptionFixture();
    const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
    f.manifest.retainedPublicationPayloads = original.publication.payloads;
    const recovered = await authenticateReceiptRecovery({
      manifest: f.manifest,
      artifact: f.aggregateArtifact,
      run: f.run,
      client: f.client,
      verifier: undefined,
      expectedRunAttempts: undefined,
    });
    expect(recovered.current.workflowRefProof).toBe("receipt-backed-recovery-v1");
    const options = {
      ...consumptionOptions(f.direct),
      run: f.run,
      manifest: f.manifest,
      expectedRunId: "900",
    };
    const strict = await validateReleaseRunEvidence(
      {
        repository: f.direct.repository,
        runId: "900",
        trustedWorkflowFullRef: f.direct.publisherFullRef,
        trustedWorkflowRef: f.direct.publisherFullRef.slice("refs/tags/".length),
        trustedWorkflowSha: f.direct.p,
        verifierSourceSha: f.direct.p,
        verifierSourceContent: options.verifierSourceContent,
      },
      f.client,
    );
    expect(strict.current.conclusion).toBe("success");
    const consumed = await authenticateFullReleaseValidationEvidence(options, f.client);
    expect(consumed.evidence.current.conclusion).toBe("success");
    // This is the already-authenticated handoff used by publication preflight.
    const publication = consumed.forPublication(options);
    const artifactFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith("https://registry.npmjs.org/")
        ? Promise.resolve(Response.json({ versions: {}, "dist-tags": {} }))
        : artifactFetch(input, init);
    });
    vi.spyOn(preflightTransport, "createPublishPreflightGh").mockReturnValue((args) => {
      const path = args[1] ?? "";
      if (path.includes("/git/ref/tags/")) {
        return JSON.stringify({
          ref: f.direct.publisherFullRef,
          object: { type: "commit", sha: f.direct.p },
        });
      }
      return f.runGh(args);
    });
    const manifestReads = vi.spyOn(f.client, "loadManifest");
    vi.spyOn(preflightTransport, "createPublishPreflightEvidenceClient").mockReturnValue(f.client);
    const preflight = await runReleasePublishPreflight(
      {
        repo: f.direct.repository,
        tag: "v2026.8.28-beta.1",
        fullReleaseValidationRunId: "900",
        fullReleaseValidationRunAttempt: 1,
        npmDistTag: "beta",
        pluginPublishScope: "all-publishable",
        workflowRef: f.direct.publisherFullRef.slice("refs/tags/".length),
      },
      {
        manifest: f.manifest,
        targetSha: f.direct.q,
        toolingSha: f.direct.p,
        allowPlannedTag: true,
        fullValidationEvidence: consumed,
      },
    );
    // Only the changed provenance gate is under test. Synthetic Q has no local
    // checkout or registry publication, so unrelated release gates must not pass.
    expect(preflight.rows.find((row) => row.id === "validation.provenance")).toMatchObject({
      status: "PASS",
    });
    expect(preflight.failed).toBe(true);
    expect(manifestReads).not.toHaveBeenCalled();
    expect(publication.source).toBe("receipt-backed-recovery-v1");
    const direct = await authenticateFullReleaseValidationEvidence(consumptionOptions(f.direct), {
      ...f.client,
      ...f.direct.client,
    });
    for (const [result, kind] of [
      [direct, "direct"],
      [consumed, "recovery"],
    ] as const) {
      expect(result.qualification).toMatchObject({
        kind,
        candidateSha: f.direct.q,
        qualificationSha: f.direct.q,
        admission: f.direct.admission.receipt,
        coverage: f.direct.admission.receipt.coverage,
        coveragePolicy: "npm-beta-v1",
      });
    }
  });
});

describe("recovery qualification integrity at consumption", () => {
  it.each([
    ["admission", "Qualification operator no longer has repository qualification authority"],
    ["candidate", "aggregate changed the original candidate"],
    ["run attempt", "current successful attempt"],
    ["workflow", "full release parent run binding mismatch"],
    ["artifact", "expired"],
    [
      "recovery authority",
      "Qualification operator no longer has repository qualification authority",
    ],
    ["waiver", "aggregate waivers differ"],
    ["missing admission", "unexpected request fields"],
    ["forged admission", "artifact"],
    ["wrong run", "runId does not match"],
    ["wrong aggregate attempt", "manifest artifact is not compatible"],
    ["missing recovery authentication", "authenticated operator"],
    ["artifact bytes", "artifact"],
    ["missing child", "five complete beta roles"],
    ["uncovered failure", "live composite workload"],
  ])("rejects changed %s", async (fault, message) => {
    const f = recoveryConsumptionFixture();
    const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
    f.manifest.retainedPublicationPayloads = original.publication.payloads;
    if (fault === "admission") {
      f.direct.admission.authority.permission = "read";
    }
    if (fault === "candidate") {
      f.recovery.candidateBinding.request.targetSha = "f".repeat(40);
    }
    if (fault === "run attempt") {
      f.runs.get(f.recovery.children.normalCi!.runId)!.run_attempt = 2;
    }
    if (fault === "workflow") {
      f.run.path = ".github/workflows/ci.yml";
    }
    if (fault === "artifact") {
      f.metadata.get("103")!.expired = true;
    }
    if (fault === "recovery authority") {
      f.recoveryAuthority.permission = "read";
    }
    if (fault === "waiver") {
      Object.assign(f.manifest, { waivers: [{ reason: "caller supplied waiver" }] });
    }
    if (fault === "missing admission") {
      Reflect.deleteProperty(f.recovery, "qualificationAdmission");
    }
    if (fault === "forged admission") {
      f.recovery.qualificationAdmission.artifactDigest = "sha256:" + "f".repeat(64);
    }
    if (fault === "wrong run") {
      f.run.id = 901;
    }
    if (fault === "wrong aggregate attempt") {
      f.run.run_attempt = 2;
    }
    if (fault === "missing recovery authentication") {
      Reflect.deleteProperty(f.run, "triggering_actor");
    }
    if (fault === "artifact bytes") {
      f.archives.set(
        f.manifest.publicationAdmission.binding.artifact.id,
        Buffer.from("tampered observation artifact"),
      );
    }
    if (fault === "missing child") {
      Reflect.deleteProperty(f.recovery.children, "normalCi");
    }
    if (fault === "uncovered failure") {
      f.jobs.get(f.recovery.children.normalCi!.runId)![0]!.conclusion = "failure";
    }
    await expect(
      authenticateFullReleaseValidationEvidence(
        {
          ...consumptionOptions(f.direct),
          run: f.run,
          manifest: f.manifest,
          expectedRunId: "900",
        },
        f.client,
      ),
    ).rejects.toThrow(message);
  });
});
