import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verifyOriginalReceiptQualification } from "../../scripts/full-release-receipt-recovery.mjs";
import { authenticatePreparedNpmArtifact } from "../../scripts/plugin-npm-prepared-release.mjs";
import { recoveryConsumptionFixture } from "./release-evidence-consumption.test-support.js";

it.each([false, true])(
  "consumes original Q plugin bytes through authenticated recovery (independent Q=%s)",
  async (independentQ) => {
    const f = recoveryConsumptionFixture(independentQ);
    const original = await verifyOriginalReceiptQualification(f.recovery, { client: f.client });
    f.manifest.retainedPublicationPayloads = original.publication.payloads;
    const { c, q, p, repository, publisherFullRef } = f.direct;
    const descriptor = f.manifest.publicationArtifacts.pluginNpm;
    const result = await authenticatePreparedNpmArtifact({
      repository,
      sourceSha: c,
      workflowSha: p,
      workflowFullRef: publisherFullRef,
      artifact: descriptor,
      fullReleaseValidationRunId: "900",
      fullReleaseValidationRunAttempt: 1,
      evidenceClient: f.client,
      npmDistTag: "default",
      selectionMode: "all-publishable",
    });
    expect(result.artifact).toEqual(descriptor);
    expect(result.workflowSha).toBe(q);
    expect(result.publisherPolicySha256).toBe(
      createHash("sha256")
        .update(f.client.getWorkflowSource(q, ".github/workflows/plugin-npm-release.yml"))
        .digest("hex"),
    );
    f.recoveryAuthority.permission = "read";
    expect(() => result.revalidateAuthority()).toThrow("qualification authority");
  },
);
