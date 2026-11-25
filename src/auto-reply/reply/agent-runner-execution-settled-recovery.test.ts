import { assert, expect, it } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import { setupExecutionSuite } from "./agent-runner-execution-suite.test-support.js";

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
const { state, runTurn, terminalEvents } = await setupExecutionSuite();

it.each([false, true])(
  "settles the selected attempt through the real candidate and backstop (later failure=%s)",
  async (laterFailure) => {
    const failure = laterFailure ? "recovery persistence failed" : undefined;
    const route = { provider: "anthropic", model: "claude" };
    const selectedReceipt = {
      runId: "recovered-reply",
      sessionId: "session",
      turnId: "recovery",
      requested: route,
      effective: { ...route, responseModel: "claude" },
      successfulToolNames: ["write"],
      assistantTranscriptIdempotencyKey: "selected-recovery",
      rerouted: false,
      terminalDisposition: "visible" as const,
    };
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: RunEmbeddedAgentInternalParams) => {
        selectedReceipt.runId = params.runId;
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: "finishing",
            error: "old capacity error",
            errorObservation: { httpStatus: 503 },
            stopReason: "error",
            assistantTranscriptIdempotencyKey: "superseded-attempt",
          },
        });
        expect(params.onAttemptTerminalReplaced).toEqual(expect.any(Function));
        params.onAttemptTerminalReplaced?.();
        if (failure) {
          await params.onAgentEvent?.({
            stream: "lifecycle",
            data: { phase: "finishing", error: failure },
          });
        }
        return {
          payloads: [{ text: "The write completed." }],
          meta: {
            stopReason: laterFailure ? "error" : "stop",
            terminalReply: { disposition: "visible", text: "The write completed." },
            ...(failure ? { error: { kind: "incomplete_turn", message: failure } } : {}),
            agentMeta: { sessionId: "session", ...route, terminalReceipt: selectedReceipt },
          },
        };
      },
    );
    const result = await runTurn();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const terminals = terminalEvents(selectedReceipt.runId);
    expect(terminals).toHaveLength(1);
    const [terminal] = terminals;
    assert.isDefined(terminal);
    expect(terminal.data).toMatchObject({
      phase: laterFailure ? "error" : "end",
      executionSettled: true,
      terminalReceipt: selectedReceipt,
    });
    expect(terminal.data.error).toBe(failure);
    expect(terminal.data).not.toHaveProperty("errorObservation");
    expect(terminal.data.assistantTranscriptIdempotencyKey).not.toBe("superseded-attempt");
    assert(result.kind === "success");
    expect(result.runResult.meta.error?.message).toBe(failure);
  },
);
