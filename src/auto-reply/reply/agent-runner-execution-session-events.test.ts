import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { SessionEventExecution } from "./session-event-contract.js";

useBundledProviderPolicyArtifactsForTest(["anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

function createEventExecution(): SessionEventExecution {
  return { onStarted: vi.fn(), onTerminal: vi.fn() };
}

describe("ordinary session event execution", () => {
  it("waits for source preparation and rejects revoked authority before runtime I/O", async ({
    signal,
  }) => {
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    const event = createEventExecution();
    event.assertCurrent = () => {
      if (!current) {
        throw new Error("event source retired");
      }
    };
    event.beforeStart = async () => {
      entered.resolve();
      await release.promise;
    };
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    const pending = executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    const rejected = expect(pending).rejects.toThrow("event source retired");
    try {
      await withinTest(entered.promise, signal);
      current = false;
      expect(state.resolveCurrentTurnImagesMock).not.toHaveBeenCalled();
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(event.onTerminal).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await rejected;
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(event.onStarted).not.toHaveBeenCalled();
    expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(expect.any(String), "failed");
  });

  it("records event start and terminal once through the ordinary embedded executor", async () => {
    const event = createEventExecution();
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        expect(params.trigger).toBe("event");
        params.onExecutionPhase?.({ phase: "model_call_started" });
        params.onExecutionPhase?.({ phase: "assistant_output_started" });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    expect(result.outcome).toMatchObject({ kind: "settled", status: "ok" });
    expect(event.onStarted).toHaveBeenCalledExactlyOnceWith(result.runId);
    expect(event.onTerminal).toHaveBeenCalledExactlyOnceWith(result.runId, "completed");
  });

  it("does not record a second terminal when the source terminal callback fails", async () => {
    const event = createEventExecution();
    const terminal = vi.fn(async () => {
      throw new Error("event settlement retired");
    });
    event.onTerminal = terminal;
    const followupRun = createFollowupRun();
    followupRun.run.internalEventExecution = event;
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    await expect(
      executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun })),
    ).rejects.toThrow("event settlement retired");
    expect(terminal).toHaveBeenCalledExactlyOnceWith(expect.any(String), "completed");
  });
});
