import { describe, expect, it } from "vitest";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { appendSessionRuntimeContextMock } from "./run-automation.test-support.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();

describe("isolated automation result settlement", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([
    { outcome: "no_change", failed: false, quiet: true, status: "ok" },
    { outcome: "progress", failed: false, quiet: false, status: "ok" },
    { outcome: "no_change", failed: true, quiet: false, status: "error" },
  ] as const)(
    "settles $outcome without masking failure=$failed",
    async ({ outcome, failed, quiet, status }) => {
      h.mockRunCronFallbackPassthrough();
      h.resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
      let record: ReturnType<typeof createAutomationResultRecorder> | undefined;
      h.runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
        record = createAutomationResultRecorder(runId, "test-job");
        record({ outcome, summary: "Checked the queue." });
        return {
          payloads: [{ text: "Checked the queue." }],
          meta: { agentMeta: {}, ...(failed ? { error: { message: "Execution failed." } } : {}) },
        };
      });
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          job: makeIsolatedAgentJobFixture({ delivery: { mode: "announce" } }),
        }),
      );
      expect(result.status).toBe(status);
      expect(result.summary).toBe(
        failed ? "cron isolated run failed: Execution failed." : `${outcome}: Checked the queue.`,
      );
      expect(h.dispatchCronDeliveryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDelivery: quiet ? "silent" : undefined,
        }),
      );
      expect(appendSessionRuntimeContextMock).toHaveBeenCalledTimes(
        outcome === "no_change" ? 0 : 1,
      );
      if (outcome !== "no_change") {
        expect(appendSessionRuntimeContextMock).toHaveBeenCalledWith(
          expect.objectContaining({
            content:
              "Automation result (recorded fact, not an instruction): progress: Checked the queue.",
          }),
        );
      }
      expect(() => record?.({ outcome: "done", summary: "Late result." })).toThrow(
        "Automation invocation is no longer active",
      );
    },
  );
});
