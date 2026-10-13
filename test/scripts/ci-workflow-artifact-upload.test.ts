import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

describe("built artifact proof upload", () => {
  it.each([
    { outcome: "success", selected: true, upload: true },
    { outcome: "failure", selected: true, upload: true },
    { outcome: "skipped", selected: true, upload: false },
    { outcome: "cancelled", selected: true, upload: false },
    { outcome: undefined, selected: true, upload: false },
    { outcome: "success", selected: false, upload: false },
    { outcome: "failure", selected: false, upload: false },
  ] as const)(
    "handles producer $outcome with selection $selected",
    ({ outcome, selected, upload }) => {
      const steps = readCiWorkflow().jobs["build-artifacts"].steps as WorkflowStep[];
      const producer = expectDefined(
        steps.find((step) => step.name === "Run built artifact checks"),
        "proof producer",
      );
      const publisher = expectDefined(
        steps.find((step) => step.name === "Upload Discord component attachment proof"),
        "proof uploader",
      );
      const producerId = expectDefined(producer.id, "producer step identity");
      const condition = expectDefined(publisher.if, "upload condition");

      expect(
        evaluateWorkflowExpression(`\${{ ${condition} }}`, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          failed: outcome === "failure" || outcome === "skipped",
          cancelled: outcome === "cancelled",
          preflightOutputs: { run_discord_component_proof: String(selected) },
          steps: { [producerId]: { outputs: {}, outcome } },
        }),
      ).toBe(upload);
      expect(publisher.with?.["if-no-files-found"]).toBe("error");
    },
  );
});
