import { describe, expect, it } from "vitest";
import { buildFrozenTargetWorkflowRequest } from "../../scripts/lib/frozen-target-workflow-request.mjs";
import {
  decodePublicationDispatchEnvelope,
  publicationDispatchEnvelope,
} from "../../scripts/lib/full-release-publication-inputs.mjs";

const baselines = {
  upgradeBaseline: "openclaw@2026.8.3",
  upgradeSurvivorBaselines: ["openclaw@2026.8.2", "openclaw@2026.8.3"],
};

describe("publication dispatch frozen lane inputs", () => {
  it.each(["parent", "release-checks"])(
    "uses captured baselines for %s source admission",
    (workflow) => {
      const raw = JSON.stringify(baselines);
      const inputs =
        workflow === "parent"
          ? {
              trusted_workflow_json: publicationDispatchEnvelope(
                null,
                { validationPurpose: "diagnostic", publicationSelection: null },
                { qualification_baselines_json: raw },
              ),
            }
          : { qualification_baselines_json: raw };
      const request = buildFrozenTargetWorkflowRequest({
        ADMISSION_WORKFLOW: workflow,
        ADMISSION_INPUTS: JSON.stringify(inputs),
        ADMISSION_SELECTED_ROOT: "/candidate",
        ADMISSION_SELECTED_SHA: "a".repeat(40),
        ADMISSION_TOOLING_ROOT: "/harness",
        ADMISSION_TOOLING_SHA: "a".repeat(40),
        ADMISSION_WORKFLOW_REF:
          "openclaw/openclaw/.github/workflows/full-release-validation.yml@refs/heads/main",
        GITHUB_REPOSITORY: "openclaw/openclaw",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      });
      expect(request.options).toMatchObject({
        upgradeSurvivorBaseline: baselines.upgradeBaseline,
        upgradeSurvivorBaselines: baselines.upgradeSurvivorBaselines.join(" "),
        baselinesResolved: true,
      });
      expect(request.requestedBaselines).toMatchObject({
        baseline: baselines.upgradeBaseline,
        baselines: baselines.upgradeSurvivorBaselines.join(" "),
      });
    },
  );

  it("retains exact baselines with the intent and independent exclusion input", () => {
    const identity = { ref: "main", fullRef: "refs/heads/main", sha: "a".repeat(40) };
    const inputs = {
      extension_test_exclude_patterns_json: "[]",
      qualification_baselines_json: JSON.stringify(baselines),
    };
    const intent = { validationPurpose: "diagnostic", publicationSelection: null };
    expect(
      decodePublicationDispatchEnvelope(publicationDispatchEnvelope(identity, intent, inputs)),
    ).toEqual({ trustedWorkflow: identity, ...intent, laneInputs: inputs });
  });

  it.each([
    { ...baselines, upgradeBaseline: "openclaw@latest" },
    { ...baselines, upgradeSurvivorBaselines: [] },
    { ...baselines, upgradeSurvivorBaselines: ["openclaw@2026.8.3", "openclaw@2026.8.3"] },
    { ...baselines, unexpected: true },
  ])("rejects unbound or ambiguous baseline tuples", (value) => {
    expect(() =>
      publicationDispatchEnvelope(
        null,
        { validationPurpose: "diagnostic", publicationSelection: null },
        { qualification_baselines_json: JSON.stringify(value) },
      ),
    ).toThrow();
  });
});
