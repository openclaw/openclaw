import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { readWithdrawnUserTurnInputId } from "../../sessions/user-turn-transcript-admission.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import { errorShapeFromError } from "../error-shape.js";
import { buildAbortedAgentPayload, setGatewayDedupeEntries } from "./agent-dedupe.js";
import type { captureAgentJobSession } from "./agent-job.js";
import type { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import { projectWithdrawnAgentInput } from "./agent-run-dispatch-outcome.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Settle admitted input before queuing the undispatched result for post-cleanup publication. */
export function createAgentRunUndispatchedOutcome({
  execution,
  diagnostics,
  captureJobSession,
  settleUnstartedFollowup,
  deferFinal,
}: {
  execution: StartAgentRunExecutionParams;
  diagnostics: ReturnType<typeof createAgentRunDiagnostics>;
  captureJobSession: () => ReturnType<typeof captureAgentJobSession>;
  settleUnstartedFollowup: (outcome: AgentRunTerminalOutcome) => Promise<void> | undefined;
  deferFinal: StartAgentRunExecutionParams["io"]["emitFinal"];
}) {
  const { prepared } = execution;
  let publishAfterCleanup: (() => void) | undefined;
  const finishFailure = async (err: unknown, recordCompletion = true) => {
    const error = errorShapeFromError(ErrorCodes.UNAVAILABLE, err);
    const renderedErr = error.message;
    const outcome = buildAgentRunTerminalOutcome({ status: "error", error: renderedErr });
    if (recordCompletion) {
      try {
        await completeUserTurnProcessing(prepared.userTurn.recorder, outcome);
      } catch (completionError) {
        diagnostics.warning("input completion persistence failed")(completionError);
      }
    }
    await settleUnstartedFollowup(outcome);
    const payload = { runId: execution.runId, status: "error" as const, summary: renderedErr };
    publishAfterCleanup = () => {
      setGatewayDedupeEntries({
        dedupe: execution.context.dedupe,
        keys: execution.agentDedupeKeys,
        session: captureJobSession(),
        entry: diagnostics.forReplay({ ts: Date.now(), ok: false, payload, error }),
      });
      deferFinal([false, payload, error], {
        runId: execution.runId,
        ...diagnostics.errorMeta(renderedErr),
      });
    };
  };
  const finishUndispatchedAbort = async () => {
    const stopReason = prepared.activeRunAbort.entry?.adapter.abortStopReason?.trim() || "rpc";
    const outcome = buildAgentRunTerminalOutcome({
      status: "timeout",
      stopReason,
      timeoutPhase: "queue",
      providerStarted: false,
    });
    try {
      await completeUserTurnProcessing(prepared.userTurn.recorder, outcome);
    } catch (error) {
      // This helper also runs from the outer abort catch. A failed required
      // write must still publish a final error and release the admitted turn.
      await finishFailure(error, false);
      return;
    }
    await settleUnstartedFollowup(outcome);
    publishAfterCleanup = () => {
      const payload = projectWithdrawnAgentInput(
        buildAbortedAgentPayload(execution.runId, stopReason, {
          agentId: execution.activeSessionAgentId,
        }),
        readWithdrawnUserTurnInputId(prepared.userTurn.recorder),
      );
      setGatewayDedupeEntries({
        dedupe: execution.context.dedupe,
        keys: execution.agentDedupeKeys,
        session: captureJobSession(),
        entry: diagnostics.forReplay({ ts: Date.now(), ok: true, payload }),
      });
      deferFinal([true, payload, undefined], { runId: execution.runId });
    };
  };

  return {
    finishFailure,
    finishUndispatchedAbort,
    publishAfterCleanup: () => publishAfterCleanup?.(),
  };
}
