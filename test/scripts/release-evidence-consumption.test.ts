import { afterEach, describe, expect, it, vi } from "vitest";
import * as preflightTransport from "../../scripts/lib/release-publish-preflight-evidence.mts";
import { runReleasePublishPreflight } from "../../scripts/release-publish-preflight.mts";
import { authenticateFullReleaseValidationEvidence } from "../../scripts/validate-full-release-validation-evidence.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { consumptionOptions } from "./release-evidence-consumption.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("release evidence consumption", () => {
  it.each(["beta", "stable", "full", "extended-stable"] as const)(
    "authenticates direct %s qualification with independent candidate and tooling identities",
    async (releaseProfile) => {
      const f = candidatePublicationFixture({ releaseProfile, qualificationSha: "d".repeat(40) });
      const options = consumptionOptions(f);
      const consumed = await authenticateFullReleaseValidationEvidence(options, f.client);
      expect(consumed.qualification).toMatchObject({
        kind: "direct",
        candidateSha: "a".repeat(40),
        qualificationSha: "d".repeat(40),
        admission: f.admission.receipt,
        coverage: f.admission.receipt.coverage,
      });
      expect(consumed.forPublication(options).source).toBe("candidate-owned-admission-v1");
    },
  );

  it("passes authenticated direct qualification to preflight without authenticating it again", async () => {
    const f = candidatePublicationFixture();
    const options = consumptionOptions(f);
    const consumed = await authenticateFullReleaseValidationEvidence(options, f.client);
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ versions: {}, "dist-tags": {} })));
    vi.spyOn(preflightTransport, "createPublishPreflightGh").mockReturnValue((args) => {
      const path = args[1] ?? "";
      if (path.includes("/git/ref/tags/")) {
        return JSON.stringify({ ref: f.publisherFullRef, object: { type: "commit", sha: f.p } });
      }
      return f.runGh(args);
    });
    const manifestReads = vi.spyOn(f.client, "loadManifest");
    vi.spyOn(preflightTransport, "createPublishPreflightEvidenceClient").mockReturnValue(f.client);
    const preflight = await runReleasePublishPreflight(
      {
        repo: f.repository,
        tag: "v2026.8.28-beta.1",
        fullReleaseValidationRunId: f.runId,
        fullReleaseValidationRunAttempt: 1,
        npmDistTag: "beta",
        pluginPublishScope: "all-publishable",
        workflowRef: f.publisherFullRef.slice("refs/tags/".length),
      },
      {
        manifest: f.manifest,
        targetSha: f.c,
        toolingSha: f.p,
        allowPlannedTag: true,
        fullValidationEvidence: consumed,
      },
    );
    // Synthetic candidate has no checkout or registry publication; only provenance passes.
    expect(preflight.rows.find((row) => row.id === "validation.provenance")).toMatchObject({
      status: "PASS",
    });
    expect(preflight.failed).toBe(true);
    expect(manifestReads).not.toHaveBeenCalled();
    f.admission.authority.permission = "read";
    expect(() => consumed.forPublication(options)).toThrow(/qualification authority/iu);
  });

  it.each(["beta", "stable", "full", "extended-stable"] as const)(
    "requires fresh qualification for retired receipt recovery on %s",
    async (releaseProfile) => {
      const f = candidatePublicationFixture({ releaseProfile });
      Object.assign(f.manifest, {
        receiptRecovery: { schema: "openclaw.full-release-receipt-recovery/v1" },
      });
      await expect(
        authenticateFullReleaseValidationEvidence(consumptionOptions(f), f.client),
      ).rejects.toThrow(/receipt.*recovery.*retired.*fresh.*qualification/iu);
    },
  );
});
