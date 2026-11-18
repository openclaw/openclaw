import { expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "../extensions/codex/test-api.js";
import { parseDecisionEvaluateInput } from "../src/agents/tools/decision-tool-contract.js";
import { createDecisionTool } from "../src/agents/tools/decision-tool.js";
import type { DecisionBatchV2 } from "../src/decisions/types-v2.js";

it("preserves the numeric Decision version in the Codex schema and argument parser", () => {
  const tool = createDecisionTool("main", {
    config: {
      agents: { defaults: { decisionModel: "synthetic/native" } },
      plugins: { enabled: false },
    },
  });
  expect(tool).not.toBeNull();
  const bridge = createCodexDynamicToolBridge({
    tools: [tool!],
    signal: new AbortController().signal,
    loading: "direct",
    functionToolsOnly: true,
  });

  expect(bridge.telemetry.quarantinedTools).toEqual([]);
  // Codex's JSON Schema sanitizer defaults an untyped const/enum to string.
  // Keep the numeric type explicit in the actual model-facing declaration.
  expect(bridge.specs).toEqual([
    expect.objectContaining({
      type: "function",
      name: "decision_evaluate",
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          contractVersion: expect.objectContaining({ type: "integer", const: 2 }),
        }),
      }),
    }),
  ]);

  const batch: DecisionBatchV2 = {
    state: { type: "image", dataUri: "data:image/png;base64,AA==" },
    questions: { target: { type: "box", instructions: "the square" } },
  };
  expect(parseDecisionEvaluateInput({ contractVersion: 2, ...batch })).toEqual(batch);
  expect(() => parseDecisionEvaluateInput({ contractVersion: "2", ...batch })).toThrow(
    "no evidence was sent",
  );
});
