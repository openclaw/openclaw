import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyQualificationAdmission } from "../../scripts/release-qualification-admission.mjs";
import { makeStoredZip } from "./actions-artifact-zip.test-support.js";
import {
  fixture as qualificationFixture,
  qualificationBaselinesJson,
} from "./release-qualification-admission.test-support.js";
import { qualificationExemptionFixture } from "./release-qualification-exemption.test-support.js";

export function prepareSourceInventoryAdmission(
  temporary: string,
  tooling: string,
  inputs: Record<string, string | boolean | number>,
  targetSha: string,
  version: string,
  toolingRef: string,
  fault:
    | "valid"
    | "wrong-input"
    | "wrong-archive"
    | "expired"
    | "tampered-history"
    | "revoked-operator",
) {
  const envelope = JSON.parse(String(inputs.trusted_workflow_json));
  envelope.laneInputs = { qualification_baselines_json: qualificationBaselinesJson };
  inputs.trusted_workflow_json = JSON.stringify(envelope);
  const options = {
    candidateSha: targetSha,
    candidateVersion: version,
    inputs,
    workflowSource: readFileSync(
      join(tooling, ".github/workflows/full-release-validation.yml"),
      "utf8",
    ),
    policy: JSON.parse(
      readFileSync(join(tooling, "scripts/lib/release-qualification-coverage.json"), "utf8"),
    ),
    oldestSupportedBaseline: JSON.parse(
      readFileSync(join(tooling, "scripts/lib/upgrade-survivor-scenarios.json"), "utf8"),
    ).oldestSupportedBaseline,
  };
  const waiver = version === "2026.9.37" ? qualificationExemptionFixture(options) : undefined;
  const proof = waiver?.f ?? qualificationFixture(false, options);
  const archive = waiver
    ? makeStoredZip({ "qualification-admission.json": JSON.stringify(waiver.produce()) })
    : proof.archive();
  if (waiver) {
    proof.metadata.digest = "sha256:" + createHash("sha256").update(archive).digest("hex");
    proof.metadata.size_in_bytes = archive.length;
    proof.descriptor.artifactDigest = proof.metadata.digest;
    proof.descriptor.artifactSizeBytes = archive.length;
    inputs.trusted_workflow_json = proof.selected.inputs.trusted_workflow_json;
    Object.assign(envelope, JSON.parse(inputs.trusted_workflow_json));
  }
  const responses: Record<string, string> = {};
  verifyQualificationAdmission({
    descriptor: proof.descriptor,
    repository: "openclaw/openclaw",
    candidateSha: targetSha,
    qualificationSha: targetSha,
    workflowRef: toolingRef,
    inputs,
    runGh: (args) => {
      const raw = waiver ? waiver.runGh(args) : proof.runGh(args);
      if (typeof raw === "string") {
        responses[JSON.stringify(args)] = raw;
      }
      return raw;
    },
    downloadArchive: (args) => (args[1]?.endsWith("/70/zip") ? archive : waiver!.archive),
  });
  envelope.qualificationAdmission = proof.descriptor;
  inputs.trusted_workflow_json = JSON.stringify(envelope);
  if (fault === "wrong-input") {
    inputs.mode = "fresh";
  }
  if (fault === "expired") {
    for (const key of Object.keys(responses)) {
      if (key.includes("actions/artifacts/70")) {
        responses[key] = JSON.stringify({ ...JSON.parse(responses[key]!), expired: true });
      }
    }
  }
  writeFileSync(join(temporary, "qualification-responses.json"), JSON.stringify(responses));
  if (waiver) {
    const historical = Buffer.from(waiver.archive);
    if (fault === "tampered-history") {
      historical[0] = historical[0]! ^ 1;
    }
    writeFileSync(join(temporary, "historical.zip"), historical);
  }
  if (fault === "wrong-archive") {
    archive[0] = archive[0]! ^ 1;
  }
  writeFileSync(join(temporary, "qualification.zip"), archive);
}

export function prepareInventoryExemptionPolicy(tooling: string) {
  const waiver = qualificationExemptionFixture();
  const path = join(tooling, "scripts/lib/release-validation-waivers.mjs");
  writeFileSync(
    path,
    readFileSync(path, "utf8")
      .replace(
        /artifactDigest: "sha256:[a-f0-9]+"/,
        'artifactDigest: "' + waiver.evidence.artifactDigest + '"',
      )
      .replace(
        /artifactSizeBytes: [0-9]+/,
        "artifactSizeBytes: " + waiver.evidence.artifactSizeBytes,
      )
      .replace(
        /receiptSha256: "[a-f0-9]+"/,
        'receiptSha256: "' + waiver.evidence.receiptSha256 + '"',
      ),
  );
}
