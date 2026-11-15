import { readFileSync } from "node:fs";
import {
  createPublicationSourceFact,
  publicationSourceRequest,
} from "../../scripts/full-release-publication-contract.mjs";
import * as qualificationAuthority from "../../scripts/release-qualification-admission.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { fixture as admissionFixture } from "./release-qualification-admission.test-support.js";

export const recoveryProfiles = ["beta", "stable", "full", "extended-stable"] as const;
type RecoveryProfile = (typeof recoveryProfiles)[number];

export function recoveryCandidateFixture(
  selectedProfile: RecoveryProfile = "beta",
  options: { version?: string } = {},
) {
  const profile = selectedProfile === "extended-stable" ? "stable" : selectedProfile;
  const candidate = candidatePublicationFixture();
  if (profile !== "beta") {
    const extended = selectedProfile === "extended-stable";
    const version = options.version ?? (extended ? "2026.8.33" : "2026.8.28");
    const inputs = {
      ...candidate.admission.receipt.request.inputs,
      release_profile: profile,
      target_context_ref: (extended ? "extended-stable/" : "release/") + version,
    };
    const envelope = JSON.parse(inputs.trusted_workflow_json);
    envelope.publicationSelection.npmDistTag = extended ? "extended-stable" : "latest";
    envelope.publicationSelection.route = extended ? "extended-stable" : "normal";
    if (extended) {
      envelope.laneInputs.qualification_baselines_json = JSON.stringify({
        upgradeBaseline: "openclaw@2026.7.33",
        upgradeSurvivorBaselines: ["openclaw@2026.7.33", "openclaw@2026.8.28"],
      });
    }
    inputs.trusted_workflow_json = JSON.stringify(envelope);
    candidate.admission = admissionFixture(true, {
      inputs,
      candidateSha: candidate.q,
      transportRef: candidate.branch,
      candidateVersion: version,
      policy: JSON.parse(readFileSync("scripts/lib/release-qualification-coverage.json", "utf8")),
      workflowSource: readFileSync(".github/workflows/full-release-validation.yml", "utf8"),
    });
    candidate.client.verifyQualificationAdmission = (verification) =>
      qualificationAuthority.verifyQualificationAdmission({
        ...verification,
        runGh: candidate.admission.runGh,
        downloadArchive: candidate.admission.archive,
      });
    candidate.client.revalidateQualificationAdmissionAuthority = (authority) =>
      qualificationAuthority.revalidateQualificationAdmissionAuthority({
        ...authority,
        runGh: candidate.admission.runGh,
      });
    candidate.source = createPublicationSourceFact(
      publicationSourceRequest({
        PUBLICATION_INPUTS_JSON: JSON.stringify(inputs),
        PUBLICATION_TOOLING_JSON: JSON.stringify(candidate.tooling),
        PUBLICATION_TARGET_CONTEXT: inputs.target_context_ref,
        PUBLICATION_TARGET_SHA: candidate.q,
        PUBLICATION_COVERAGE_POLICY: profile === "stable" && !extended ? "npm-stable-v1" : "",
        PUBLICATION_SKIP_TELEGRAM: "false",
        GITHUB_REPOSITORY: candidate.repository,
        GITHUB_REF: candidate.tooling.fullRef,
        GITHUB_SHA: candidate.q,
        GITHUB_RUN_ID: candidate.runId,
        GITHUB_RUN_ATTEMPT: "1",
      }),
      { packages: [], platforms: [] },
      { version, packages: [{ name: "openclaw", version, targets: ["npm"] }], platforms: [] },
    );
  }
  return candidate;
}
