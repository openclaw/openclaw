import { describe, expect, it } from "vitest";
import { resolveNextSafeTaskCardIdFromGraph } from "../../scripts/openclaw-controlled-task-runner.mjs";

function createGraph(): Record<string, unknown> {
  return {
    kind: "openclaw-card-framework-graph",
    validation: { ok: true },
    graph: {
      nodes: [
        { id: "component-controlled-runner", type: "component", label: "Controlled runner" },
        { id: "component-validation-gate", type: "component", label: "Validation gate" },
        { id: "component-channel", type: "component", label: "Channel" },
        { id: "component-trading-runtime", type: "component", label: "Trading runtime" },
        { id: "component-trading-risk-gate", type: "component", label: "Trading risk gate" },
        { id: "component-memory", type: "component", label: "Memory" },
        { id: "component-report-state", type: "component", label: "Report state" },
      ],
      links: [],
      missingLinks: [],
      duplicateNodeIds: [],
    },
  };
}

describe("openclaw-controlled-task-runner core card routing", () => {
  it("maps controlled_task_runner_check to controlled-runner", () => {
    expect(resolveNextSafeTaskCardIdFromGraph("controlled_task_runner_check", createGraph())).toBe(
      "component-controlled-runner",
    );
  });

  it("maps capital_quote_status_check to trading-runtime", () => {
    expect(resolveNextSafeTaskCardIdFromGraph("capital_quote_status_check", createGraph())).toBe(
      "component-trading-runtime",
    );
  });

  it("maps dmad-trend to report-state", () => {
    expect(resolveNextSafeTaskCardIdFromGraph("dmad-trend", createGraph())).toBe(
      "component-report-state",
    );
  });
});
