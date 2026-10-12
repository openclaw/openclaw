import { expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { QuestionAnswerUnconfirmedError } from "../../agents/harness/gateway-question-dispatch.js";
import type { SteeringReceiptFixture } from "./agent-runner.runreplyagent.steering-receipts.cases.js";
import { createReplyOperation } from "./reply-run-registry.js";

export function registerProcessingFeedbackCases({
  createMinimalRun,
  state,
}: Pick<SteeringReceiptFixture, "createMinimalRun" | "state">): void {
  it.each(["turn_accepted", "model_call_started", "process_spawned", "preflight_error"] as const)(
    "publishes initial input feedback only after confirmed acceptance (%s)",
    async (phase) => {
      const onAdopted = vi.fn();
      const onRunIncluded = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(onRunIncluded).not.toHaveBeenCalled();
        if (phase === "preflight_error") {
          throw new AgentHarnessPreflightError("rejected before input acceptance", {
            userMessage: "The model could not start this turn.",
          });
        }
        params.onExecutionPhase?.({ phase });
        params.onExecutionPhase?.({ phase });
        expect(onRunIncluded).toHaveBeenCalledTimes(phase === "process_spawned" ? 0 : 1);
        return { payloads: [{ text: "final" }], meta: {} };
      });
      const candidate = createMinimalRun({
        opts: { turnAdoptionLifecycle: { onAdopted, onRunIncluded } },
      });
      await candidate.run();
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(onRunIncluded).toHaveBeenCalledTimes(
        phase === "turn_accepted" || phase === "model_call_started" ? 1 : 0,
      );
      if (onRunIncluded.mock.calls.length > 0) {
        const included = onRunIncluded.mock.calls[0]![0];
        expect(included.runId).toEqual(expect.any(String));
        await expect(included.completion).resolves.toBeUndefined();
      }
    },
  );

  it.each(["accepted", "indeterminate", "unconfirmed"] as const)(
    "ties steering feedback to confirmed target inclusion (%s)",
    async (outcome) => {
      const active = createReplyOperation({
        sessionKey: "main",
        sessionId: "session",
        resetTriggered: false,
      });
      active.setPhase("running");
      const onRunIncluded = vi.fn();
      const onAdopted = vi.fn();
      const candidate = createMinimalRun({
        isActive: true,
        shouldSteer: true,
        resolvedQueueMode: "steer",
        opts: { turnAdoptionLifecycle: { onAdopted, onRunIncluded } },
      });
      if (outcome === "indeterminate") {
        state.queueEmbeddedAgentMessageMock.mockRejectedValueOnce(
          new QuestionAnswerUnconfirmedError(new Error("lost answer confirmation")),
        );
      } else if (outcome === "unconfirmed") {
        state.queueEmbeddedAgentMessageMock.mockReturnValueOnce({
          queued: true,
          transcriptCommit: "unconfirmed",
          errorMessage: "receipt unavailable",
        });
      } else {
        state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
      }
      try {
        await candidate.run();
        expect(onAdopted).toHaveBeenCalledOnce();
        expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(onRunIncluded).toHaveBeenCalledTimes(outcome === "accepted" ? 1 : 0);
        if (outcome === "accepted") {
          expect(onRunIncluded.mock.calls[0]![0].completion).toBe(active.ownerSettlement);
          expect(active.result).toBeNull();
        }
      } finally {
        active.complete();
      }
    },
  );
}
