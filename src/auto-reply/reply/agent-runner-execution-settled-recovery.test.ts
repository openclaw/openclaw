import { assert, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { useBundledProviderPolicyArtifactsForTest } from "../../plugin-sdk/test-helpers/provider-policy-artifacts.test-support.js";
import {
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
const state = await setupAgentRunnerExecutionTestState();
const { emitAgentEvent } = await import("../../infra/agent-events.js");

describe("executeAgentTurn accepted recovery terminal ownership", () => {
  it.each([false, true])(
    "settles the selected attempt through the real candidate and backstop (later failure=%s)",
    async (laterFailure) => {
      const selectedReceipt = {
        runId: "recovered-reply",
        sessionId: "session",
        turnId: "recovery",
        requested: { provider: "anthropic", model: "claude" },
        effective: { provider: "anthropic", model: "claude", responseModel: "claude" },
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
          if (laterFailure) {
            await params.onAgentEvent?.({
              stream: "lifecycle",
              data: { phase: "finishing", error: "recovery persistence failed" },
            });
          }
          return {
            payloads: [{ text: "The write completed." }],
            meta: {
              durationMs: 1,
              stopReason: laterFailure ? "error" : "stop",
              terminalReply: { disposition: "visible", text: "The write completed." },
              ...(laterFailure
                ? {
                    error: {
                      kind: "incomplete_turn",
                      message: "recovery persistence failed",
                    },
                  }
                : {}),
              agentMeta: {
                sessionId: "session",
                provider: "anthropic",
                model: "claude",
                terminalReceipt: selectedReceipt,
              },
            },
          };
        },
      );
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams());
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const terminals = vi
        .mocked(emitAgentEvent)
        .mock.calls.map(([event]) => event)
        .filter(
          (event) =>
            event.runId === selectedReceipt.runId &&
            event.stream === "lifecycle" &&
            (event.data.phase === "end" || event.data.phase === "error"),
        );
      expect(terminals).toHaveLength(1);
      const [terminal] = terminals;
      assert.isDefined(terminal);
      expect(terminal.data).toMatchObject({
        phase: laterFailure ? "error" : "end",
        executionSettled: true,
        terminalReceipt: selectedReceipt,
      });
      expect(terminal.data.error).toBe(laterFailure ? "recovery persistence failed" : undefined);
      expect(terminal.data).not.toHaveProperty("errorObservation");
      expect(terminal.data.assistantTranscriptIdempotencyKey).not.toBe("superseded-attempt");
      expect(result.kind).toBe("success");
      if (result.kind === "success") {
        expect(result.runResult.meta.error?.message).toBe(
          laterFailure ? "recovery persistence failed" : undefined,
        );
      }
    },
  );
});
