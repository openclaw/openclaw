/** Composes queued admission, canonical execution, accounting, and delivery. */
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../runtime.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { accountFollowupTurn } from "./agent-runner-result-accounting.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import {
  admitFollowupTurn,
  settleQueuedFollowupPresentation,
  type AdmittedFollowupTurn,
  type FollowupRunnerParams,
} from "./followup-turn-admission.js";
import { executeFollowupTurn } from "./followup-turn-execution.js";
import {
  completeFollowupRunLifecycle,
  FollowupRunDeferredError,
  type FollowupRun,
} from "./queue.js";
import type { QueuedFollowupReplyBatch } from "./queue/types.js";
import type { ReplyOperation } from "./reply-run-registry.js";

type FollowupDrainDisposition =
  | { kind: "consumed" }
  | { kind: "deferred"; reason: string }
  | { kind: "retry"; error: unknown };

function resolveFollowupCompletion(
  outcome: AgentTurnExecutionResult["outcome"],
): QueuedFollowupReplyBatch["completion"] {
  const meta = outcome.kind === "settled" ? outcome.result.meta : undefined;
  const failed =
    outcome.kind === "rejected" || (outcome.kind === "settled" && outcome.status === "failed");
  const terminal = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: failed ? "error" : "end",
    data: {
      aborted: outcome.kind === "aborted" || meta?.aborted,
      stopReason:
        outcome.kind === "aborted"
          ? outcome.reason === "user"
            ? "aborted"
            : outcome.reason
          : meta?.stopReason,
      timeoutPhase: meta?.timeoutPhase,
      providerStarted: meta?.providerStarted,
      livenessState: meta?.livenessState,
      error:
        outcome.kind === "rejected"
          ? outcome.payload.text
          : outcome.kind === "settled" && outcome.status === "failed"
            ? outcome.terminalFailurePayload.text
            : meta?.error?.message,
    },
  });
  const classification = classifyAgentRunTerminalOutcome(terminal);
  const stopReason = terminal.stopReason ? { stopReason: terminal.stopReason } : {};
  if (classification === "cancellation") {
    return { kind: "aborted", ...stopReason };
  }
  if (classification === "failure" || classification === "timeout") {
    return {
      kind: "failed",
      error: terminal.error ?? "Follow-up failed.",
      ...stopReason,
      ...(classification === "timeout" ? { errorKind: "timeout" } : {}),
    };
  }
  return { kind: "completed", ...stopReason };
}

/** Creates the function that drains one queued follow-up run. */
export function createFollowupRunner(
  initialDefaults: FollowupRunnerParams,
): (queued: FollowupRun) => Promise<void> {
  const resolveGatewayContext = Object.hasOwn(initialDefaults, "resolveGatewayContext")
    ? initialDefaults.resolveGatewayContext
    : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const defaults = { ...initialDefaults, resolveGatewayContext };
  // Every queue handoff, including delivery retries, retains this host owner
  // without borrowing the invoking turn's request-local authority.
  const runFollowup = (queued: FollowupRun): Promise<void> =>
    withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () => executeFollowup(queued), {
      inheritRequestScope: false,
    });
  const executeFollowup = async (queued: FollowupRun): Promise<void> => {
    let disposition: FollowupDrainDisposition = { kind: "retry", error: undefined };
    let operation: ReplyOperation | undefined;
    let admittedRunId: string | undefined;
    let admittedTurn: AdmittedFollowupTurn | undefined;
    let terminalPayloads: ReplyPayload[] = [];
    const admissionNotices: ReplyPayload[] = [];
    let completion: QueuedFollowupReplyBatch["completion"] = { kind: "completed" };
    let queuedFollowupAdmitted = false;
    const initiallyAborted =
      queued.abortSignal?.aborted === true || queued.queueAbortSignal?.aborted === true;
    const endDeliveryCorrelations = initiallyAborted
      ? []
      : (queued.deliveryCorrelations ?? [])
          .map((correlation) => correlation.begin())
          .filter((end): end is () => void => typeof end === "function");
    try {
      if (initiallyAborted) {
        disposition = { kind: "consumed" };
        return;
      }
      const admission = await admitFollowupTurn({
        queued,
        defaults,
        onCompactionNoticePayload: async (payload, turn) => {
          const source = turn.queued.queuedFollowupReplyDisposition;
          if (
            source?.kind === "deliver" &&
            source.deliver.ownsCompletion?.(turn.queued.originatingChannel)
          ) {
            admissionNotices.push(payload);
          } else {
            await deliverFollowupDecision({
              decision: { kind: "deliver", payloads: [payload] },
              turn,
              defaults,
              runId: turn.runId,
              runFollowup,
              kind: "block",
            });
          }
        },
      });
      switch (admission.kind) {
        case "deferred":
          throw new FollowupRunDeferredError(
            `Follow-up reply lane is still active (${admission.reason})`,
          );
        case "skipped":
          operation = admission.operation;
          disposition = { kind: "consumed" };
          return;
        case "admitted":
          break;
      }
      const turn: AdmittedFollowupTurn = admission.turn;
      admittedTurn = turn;
      admittedRunId = turn.runId;
      operation = turn.operation;
      queuedFollowupAdmitted = true;
      const execution = await executeFollowupTurn({
        turn,
        defaults,
        onToolResult: async (payload, identity) => {
          await deliverFollowupDecision({
            decision: { kind: "deliver", payloads: [payload] },
            turn,
            defaults,
            runId: identity.runId,
            runFollowup,
            kind: "tool",
          });
        },
        onCompactionNoticePayload: async (payload, identity) => {
          await deliverFollowupDecision({
            decision: { kind: "deliver", payloads: [payload] },
            turn,
            defaults,
            runId: identity.runId,
            runFollowup,
            kind: "block",
          });
        },
      });
      // A closed execution result is terminal queue work. Commit consumption
      // before accounting/delivery so their failures cannot replay model or tool effects.
      disposition = { kind: "consumed" };
      completion = resolveFollowupCompletion(execution.execution.outcome);
      try {
        await execution.progress.drain();
      } catch (error) {
        if (completion.kind === "completed") {
          completion = { kind: "failed", error: formatErrorMessage(error) };
        }
        // Execution already settled; replaying the queued prompt could duplicate side effects.
        defaultRuntime.error?.(
          `followup queue: progress presentation failed after execution: ${formatErrorMessage(error)}`,
        );
        operation.fail("run_failed", error);
      }
      // Admission can fail after compaction. Publish its notices only once this
      // execution is consumed and its terminal delivery owner can close the run.
      if (
        admissionNotices.length > 0 &&
        turn.sendPolicy === "allow" &&
        turn.queued.currentInboundEventKind !== "room_event"
      ) {
        await deliverFollowupDecision({
          decision: { kind: "deliver", payloads: admissionNotices },
          turn,
          defaults,
          runId: turn.runId,
          runFollowup,
          kind: "block",
        });
      }
      if (
        execution.execution.outcome.kind === "settled" &&
        hasCompletedSourceReplyDeliveryEvidence(execution.execution.outcome.result)
      ) {
        await defaults.opts?.onObservedReplyDelivery?.();
      }
      const accounting = await accountFollowupTurn({ turn, defaults, execution });
      const deliveryOpts = {
        ...defaults.opts,
        commentaryPayloadsEnabled: execution.commentaryPayloadsEnabled,
      };
      const decision = resolveFollowupDeliveryDecision({
        turn,
        execution: execution.execution,
        accounting,
        opts: deliveryOpts,
      });
      if (
        completion.kind === "completed" &&
        decision.kind === "suppress" &&
        (decision.reason === "silent" || decision.reason === "message-tool-only")
      ) {
        completion = { ...completion, allowCanvasOnly: true };
      }
      const delivery = await deliverFollowupDecision({
        decision,
        turn,
        defaults,
        runId: execution.execution.runId,
        runFollowup,
      });
      // Source recovery has its own queued callback; this execution still closes once.
      terminalPayloads = delivery.kind === "completed" ? delivery.payloads : [];
    } catch (error) {
      if (error instanceof FollowupRunDeferredError) {
        disposition = { kind: "deferred", reason: error.message };
      } else if (
        operation?.result?.kind === "aborted" &&
        operation.result.code === "aborted_by_user"
      ) {
        disposition = { kind: "consumed" };
        completion = resolveFollowupCompletion({ kind: "aborted", reason: "user" });
      } else if (disposition.kind === "consumed") {
        completion = { kind: "failed", error: formatErrorMessage(error) };
        defaultRuntime.error?.(
          `followup queue: terminal handling failed after execution; refusing replay: ${formatErrorMessage(error)}`,
        );
        operation?.fail("run_failed", error);
      } else {
        disposition = { kind: "retry", error };
      }
    } finally {
      const sourceDisposition = admittedTurn?.queued.queuedFollowupReplyDisposition;
      if (
        disposition.kind === "consumed" &&
        admittedTurn &&
        sourceDisposition?.kind === "deliver"
      ) {
        try {
          await sourceDisposition.deliver({
            kind: "queued-followup",
            runId: admittedTurn.runId,
            originatingChannel: admittedTurn.queued.originatingChannel,
            payloads: terminalPayloads,
            completion,
          });
        } catch (error) {
          defaultRuntime.error?.(
            `followup queue: completion delivery failed; refusing replay: ${formatErrorMessage(error)}`,
          );
          operation?.fail("run_failed", error);
        }
      }
      if (queuedFollowupAdmitted) {
        await settleQueuedFollowupPresentation(defaults);
      }
      for (const end of endDeliveryCorrelations.toReversed()) {
        try {
          end();
        } catch (error) {
          defaultRuntime.error?.(
            `followup queue: delivery correlation cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      if (disposition.kind === "consumed") {
        completeFollowupRunLifecycle(queued);
        if (admittedRunId) {
          clearAgentRunContext(admittedRunId);
        }
      } else if (disposition.kind === "retry" && admittedRunId) {
        clearAgentRunContext(admittedRunId);
      }
      operation?.complete();
      defaults.typing.markRunComplete();
      defaults.typing.markDispatchIdle();
    }
    if (disposition.kind === "deferred") {
      throw new FollowupRunDeferredError(
        `Follow-up reply lane is still active (${disposition.reason})`,
      );
    }
    if (disposition.kind === "retry") {
      throw disposition.error;
    }
  };
  return runFollowup;
}
