import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  getRawExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

useBundledProviderPolicyArtifactsForTest(["anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getRawExecuteAgentTurnForTest();
const registry = await import("../../infra/agent-run-registry.js");

it("keeps a scheduled check off active-session projection without disabling its results", async ({
  onTestFinished,
}) => {
  const actual = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
    "../../infra/agent-run-registry.js",
  );
  vi.mocked(registry.registerAgentRunContext).mockImplementation(actual.registerAgentRunContext);
  onTestFinished(() => actual.resetAgentRunRegistryForTest());
  const runId = "quiet-scheduled-activity";
  const followupRun = createFollowupRun();
  followupRun.run.inputProvenance = { kind: "internal_system", sourceTool: "cron_execution" };
  state.isInternalMessageChannelMock.mockReturnValue(true);
  const events: AgentEventPayload[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId === runId) {
      events.push(event);
    }
  });
  onTestFinished(unsubscribe);
  state.runEmbeddedAgentMock.mockImplementationOnce(
    async (params: RunEmbeddedAgentInternalParams) => {
      params.onExecutionPhase?.({ phase: "model_call_started" });
      const context = registry.getAgentRunContext(runId);
      expect(context).toMatchObject({
        projectSessionActive: false,
        projectSessionLifecycle: false,
      });
      expect(context?.isControlUiVisible).not.toBe(false);
      expect(context?.projectSessionMessages).not.toBe(false);
      expect(registry.buildProjectedAgentRunIndex().sessionKeys.size).toBe(0);
      return {
        payloads: [{ text: "The review is ready.", mediaUrl: "https://example.test/report.png" }],
        meta: {},
      };
    },
  );
  const { replyOperation } = createMockReplyOperation();
  const result = await executeAgentTurn(
    createMinimalRunAgentTurnParams({ followupRun, replyOperation, opts: { runId } }),
  );
  expect(result.outcome).toMatchObject({
    kind: "settled",
    result: {
      payloads: [{ text: "The review is ready.", mediaUrl: "https://example.test/report.png" }],
    },
  });
  expect(events.some((event) => event.stream === "run_status")).toBe(true);
  expect(events.filter((event) => event.stream === "run_status")).toEqual(
    expect.arrayContaining([expect.objectContaining({ projectSessionLifecycle: false })]),
  );
});
