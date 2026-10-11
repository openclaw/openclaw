import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.ts";
import { evaluateWorkflowExpression, readCiWorkflow } from "./ci-workflow.test-support.ts";

describe("Control UI WebKit selection", () => {
  it.each([
    ["ui/vitest.config.ts", true],
    ["ui/src/components/modal-dialog.ts", true],
    ["ui/src/pages/chat/components/chat-composer.tsx", true],
    ["ui/src/styles/chat/composer.css", true],
    ["ui/src/pages/about/about-page.ts", false],
  ])("selects %s: %s without adding UI rows", (file, selected) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      eventName: "pull_request",
      runNode: false,
      changedPaths: [file],
      scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "true" },
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_ui_webkit).toBe(String(selected));
    expect(JSON.parse(expectDefined(result.outputs.ui_test_matrix, "UI matrix")).include).toEqual([
      { shard: 1 },
      { shard: 2 },
      { shard: 3 },
    ]);
  });

  it.each([
    { eventName: "schedule" as const, changedPaths: null },
    { eventName: "workflow_dispatch" as const, changedPaths: ["ui/vitest.config.ts"] },
    {
      eventName: "pull_request" as const,
      changedPaths: ["ui/vitest.config.ts"],
      scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "false" },
    },
  ])("omits WebKit when its current UI row is unavailable: %j", (options) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      runNode: false,
      scopeEnv: { OPENCLAW_CI_RUN_UI_TESTS: "true" },
      ...options,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_ui_webkit).toBe("false");
  });

  it("runs the install and browser proof only in the selected first UI shard", () => {
    const workflow = readCiWorkflow();
    const steps = workflow.jobs["checks-ui"].steps.filter((step: { name?: string }) =>
      step.name?.includes("WebKit"),
    );
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      for (const [shard, selected, expected] of [
        [1, "true", true],
        [2, "true", false],
        [1, "false", false],
      ] as const) {
        expect(
          evaluateWorkflowExpression(step.if, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            matrix: { shard },
            preflightOutputs: { run_ui_webkit: selected },
          }),
        ).toBe(expected);
      }
    }
    expect(workflow.jobs["checks-ui"].strategy["max-parallel"]).toBe(3);
  });
});
