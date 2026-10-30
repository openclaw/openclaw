import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyQualificationAdmission } from "../../scripts/release-qualification-admission.mjs";
import {
  fixture as qualificationFixture,
  qualificationBaselinesJson,
} from "./release-qualification-admission.test-support.js";

export function prepareSourceInventoryAdmission(
  temporary: string,
  tooling: string,
  inputs: Record<string, string | boolean | number>,
  targetSha: string,
  version: string,
  toolingRef: string,
  fault: "valid" | "wrong-input" | "wrong-archive" | "expired",
) {
  const envelope = JSON.parse(String(inputs.trusted_workflow_json));
  envelope.laneInputs = { qualification_baselines_json: qualificationBaselinesJson };
  inputs.trusted_workflow_json = JSON.stringify(envelope);
  const proof = qualificationFixture(false, {
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
  });
  const responses: Record<string, string> = {};
  verifyQualificationAdmission({
    descriptor: proof.descriptor,
    repository: "openclaw/openclaw",
    candidateSha: targetSha,
    qualificationSha: targetSha,
    workflowRef: toolingRef,
    inputs,
    runGh: (args) => {
      const raw = proof.runGh(args);
      responses[JSON.stringify(args)] = raw;
      return raw;
    },
    downloadArchive: () => proof.archive(),
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
  const archive = proof.archive();
  if (fault === "wrong-archive") {
    archive[0] = archive[0]! ^ 1;
  }
  writeFileSync(join(temporary, "qualification.zip"), archive);
}
