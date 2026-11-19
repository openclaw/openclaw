import { readFileSync } from "node:fs";
import type { candidatePublicationFixture } from "./candidate-publication.test-support.js";

export function consumptionOptions(f: ReturnType<typeof candidatePublicationFixture>) {
  return {
    run: f.parent,
    manifest: f.manifest,
    expectedRepository: f.repository,
    expectedRunId: f.runId,
    expectedRunAttempt: 1,
    expectedTargetSha: f.c,
    expectedReleaseTag: "v" + f.admission.receipt.baselinePolicy.candidateVersion,
    expectedTrustedWorkflowFullRef: f.publisherFullRef,
    expectedTrustedWorkflowSha: f.p,
    expectedCoreNpmPublication: { npmDistTag: f.source.publicationSelection!.npmDistTag },
    verifierSourceSha: f.p,
    verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
  };
}
