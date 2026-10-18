import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { runWithAgentWorkspaceReadiness } from "../../agents/workspace-readiness.js";
import type { ProgressContinuationCapability } from "../../channels/progress-continuation.js";
import { withoutSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { SessionActivitySummaryCompletion } from "../../gateway/session-activity-summary-completion.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../../runtime.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { accountFollowupTurn } from "./agent-runner-result-accounting.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { settleQueuedFollowupPresentation } from "./followup-presentation.js";
import {
  admitFollowupTurn,
  type AdmittedFollowupTurn,
  type FollowupRunnerParams,
} from "./followup-turn-admission.js";
import { executeFollowupTurn } from "./followup-turn-execution.js";
import { enqueueGoalContinuation } from "./goal-continuation.js";
import {
  completeFollowupRunLifecycle,
  FollowupRunDeferredError,
  type FollowupRun,
} from "./queue.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { isFollowupRunAborted, type QueuedFollowupReplyBatch } from "./queue/types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import {
  getReplyOperationSessionReader,
  retainReplyOperationUntilComplete,
} from "./reply-run-registry.state.js";
import {
  isReplyOperationStalledBeforeOutput,
  STALLED_TURN_NOTICE_TEXT,
} from "./stalled-turn-recovery.js";

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
            ? (outcome.terminalFailurePayload?.text ?? meta?.error?.message)
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

export function createFollowupRunner(
  initialDefaults: FollowupRunnerParams,
): (queued: FollowupRun) => Promise<void> {
  const resolveGatewayContext = Object.hasOwn(initialDefaults, "resolveGatewayContext")
    ? initialDefaults.resolveGatewayContext
    : getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext;
  const defaults = { ...initialDefaults, resolveGatewayContext };
  // Follow-ups retain the host owner, never the invoking turn's transcript or request scope.
  const runFollowup = (queued: FollowupRun): Promise<void> =>
    withoutSessionTranscriptReadFence(() =>
      runWithAgentWorkspaceReadiness(undefined, () =>
        withPluginRuntimeGatewayContextResolver(
          resolveGatewayContext,
          () => executeFollowup(queued),
          {
            inheritRequestScope: false,
          },
        ),
      ),
    );
  const executeFollowup = async (queued: FollowupRun): Promise<void> => {
    let disposition: "retry" | "consumed" | "deferred" = "retry";
    let operation: ReplyOperation | undefined;
    let admittedTurn: AdmittedFollowupTurn | undefined;
    let activitySummaryCompletion: SessionActivitySummaryCompletion | undefined;
    let terminalPayloads: ReplyPayload[] = [];
    let progressContinuation: ProgressContinuationCapability | undefined;
    const admissionNotices: ReplyPayload[] = [];
    let completion: QueuedFollowupReplyBatch["completion"] = { kind: "completed" };
    let visibleReplySent = false;
    let deliveryPending = false;
    let sourceRetryPending = false;
    const onObservedReplyDelivery = async () => {
      if (visibleReplySent) {
        return;
      }
      visibleReplySent = true;
      await defaults.opts?.onObservedReplyDelivery?.();
    };
    const deliverProgress = async (
      turn: AdmittedFollowupTurn,
      payloads: ReplyPayload[],
      kind: "tool" | "block",
    ) => {
      const delivery = await deliverFollowupDecision({
        decision: { kind: "deliver", payloads },
        turn,
        defaults,
        runId: turn.runId,
        runFollowup,
        kind,
        onObservedReplyDelivery,
      });
      deliveryPending ||= delivery.kind === "pending";
    };
    const endDeliveryCorrelations = (queued.deliveryCorrelations ?? [])
      .map((correlation) => correlation.begin())
      .filter((end) => typeof end === "function");
    try {
      if (isFollowupRunAborted(queued)) {
        disposition = "consumed";
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
            await deliverProgress(turn, [payload], "block");
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
          disposition = "consumed";
          return;
        case "admitted":
          break;
      }
      const turn: AdmittedFollowupTurn = admission.turn;
      admittedTurn = turn;
      operation = turn.operation;
      if (turn.session.kind === "session" && turn.session.storePath) {
        activitySummaryCompletion =
          resolveGatewayContext?.()?.sessionActivitySummaries?.beginCompletion(
            {
              agentId: turn.queued.run.agentId,
              key: turn.session.key,
              storePath: turn.session.storePath,
            },
            turn.session.current(),
          );
      }
      const initialGoalId = turn.session.current()?.goal?.id;
      retainReplyOperationUntilComplete(operation);
      const execution = await executeFollowupTurn({
        turn,
        defaults,
        onToolResult: (payload) => deliverProgress(turn, [payload], "tool"),
        onCompactionNoticePayload: (payload) => deliverProgress(turn, [payload], "block"),
      });
      // A closed execution result is terminal queue work. Commit consumption
      // before accounting/delivery so their failures cannot replay model or tool effects.
      disposition = "consumed";
      completion =
        turn.queued.stalledTurnRecovery === true &&
        isReplyOperationStalledBeforeOutput(turn.operation)
          ? // A watchdog stall is a failure, not a user cancel: source owners
            // surface its last-resort notice through their terminal error.
            { kind: "failed", error: STALLED_TURN_NOTICE_TEXT }
          : resolveFollowupCompletion(execution.execution.outcome);
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
        await deliverProgress(turn, admissionNotices, "block");
      }
      if (
        execution.execution.outcome.kind === "settled" &&
        hasCompletedSourceReplyDeliveryEvidence(execution.execution.outcome.result)
      ) {
        await onObservedReplyDelivery();
      }
      const deliveryOpts = {
        ...defaults.opts,
        sourceReplyDeliveryMode: turn.queued.run.sourceReplyDeliveryMode,
        resolveReplyDelivery: turn.queued.runObservers?.resolveReplyDelivery,
        resolveReplyDeliveryFacts: turn.queued.runObservers?.resolveReplyDeliveryFacts,
        commentaryPayloadsEnabled: execution.commentaryPayloadsEnabled,
        onObservedReplyDelivery,
      };
      const { decision, accounting: completedAccounting } = await withAgentTurnCompletion(
        {
          agentId: turn.queued.run.agentId,
          storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
          sessionKey: turn.session.kind === "session" ? turn.session.key : undefined,
          entry: turn.session.current(),
          writer:
            execution.execution.outcome.kind === "settled"
              ? execution.execution.outcome.sessionWriter
              : undefined,
          operation: turn.operation,
          activitySummaryCompletion,
          publish: (entry) => turn.session.publish(entry),
        },
        async (turnCompletion) => {
          const accounting = await accountFollowupTurn({
            turn,
            defaults,
            execution,
            completion: turnCompletion,
          });
          const resolved = await resolveFollowupDeliveryDecision({
            turn,
            execution: execution.execution,
            accounting,
            opts: deliveryOpts,
          });
          await turnCompletion?.complete();
          return { decision: resolved, accounting };
        },
      );
      if (decision.kind === "deliver") {
        for (const payload of decision.payloads) {
          progressContinuation = getReplyPayloadMetadata(payload)?.progressContinuation;
          if (progressContinuation) {
            break;
          }
        }
      }
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
        onObservedReplyDelivery,
      });
      // Source recovery has its own queued callback; this execution still closes once.
      terminalPayloads = delivery.kind === "source-retry" ? [] : delivery.payloads;
      deliveryPending ||= delivery.kind === "pending";
      sourceRetryPending = delivery.kind === "source-retry";
      // Gateway final batches are returned above, not delivered: their one-shot
      // source owner settles in finally. Allocate its successor before that boundary.
      if (
        completion.kind === "completed" &&
        completedAccounting?.activeSessionEntry?.goal?.status === "active" &&
        turn.session.kind === "session" &&
        turn.session.storePath
      ) {
        await enqueueGoalContinuation({
          base: turn.queued,
          result: completedAccounting.runResult,
          initialGoalId: turn.queued.goalContinuation?.goalId ?? initialGoalId,
          expectedSession: completedAccounting.expectedSession,
          sessionKey: turn.session.key,
          storePath: turn.session.storePath,
          reader: getReplyOperationSessionReader(turn.operation),
          queueKey: turn.queued.run.sessionKey ?? turn.session.key,
          settings: resolveQueueSettings({
            cfg: turn.config,
            sessionEntry: turn.session.current(),
            channel: turn.queued.originatingChannel,
          }),
          sourceRunId: turn.runId,
          operation: turn.operation,
          runFollowup,
        });
      }
    } catch (error) {
      let operatorAuthorityLost = false;
      try {
        queued.operatorAuthority?.assertCurrent();
      } catch {
        operatorAuthorityLost = true;
      }
      if (operatorAuthorityLost) {
        // Revoked input is terminal; retrying it would hold the queue indefinitely.
        disposition = "consumed";
        completion = { kind: "aborted" };
        defaultRuntime.error?.("followup queue: canceled input after loss of operator authority");
      } else if (error instanceof FollowupRunDeferredError) {
        disposition = "deferred";
        throw new FollowupRunDeferredError(
          `Follow-up reply lane is still active (${error.message})`,
        );
      } else if (
        queued.run.internalEventExecution ||
        (operation?.result?.kind === "aborted" && operation.result.code === "aborted_by_user")
      ) {
        disposition = "consumed";
        queued.run.internalEventExecution?.onFailed?.(error);
        completion = queued.run.internalEventExecution
          ? { kind: "failed", error: formatErrorMessage(error) }
          : resolveFollowupCompletion({ kind: "aborted", reason: "user" });
      } else if (disposition === "consumed") {
        completion = { kind: "failed", error: formatErrorMessage(error) };
        defaultRuntime.error?.(
          `followup queue: terminal handling failed after execution; refusing replay: ${formatErrorMessage(error)}`,
        );
        operation?.fail("run_failed", error);
      } else {
        throw error;
      }
    } finally {
      activitySummaryCompletion?.release();
      const sourceDisposition = (admittedTurn?.queued ?? queued).queuedFollowupReplyDisposition;
      if (disposition === "consumed" && admittedTurn && sourceDisposition?.kind === "deliver") {
        try {
          await sourceDisposition.deliver({
            kind: "queued-followup",
            runId: admittedTurn.runId,
            originatingChannel: admittedTurn.queued.originatingChannel,
            payloads: terminalPayloads,
            completion,
          });
        } catch (error) {
          completion = { kind: "failed", error: formatErrorMessage(error) };
          defaultRuntime.error?.(
            `followup queue: completion delivery failed; refusing replay: ${formatErrorMessage(error)}`,
          );
          operation?.fail("run_failed", error);
        }
      }
      try {
        if (admittedTurn) {
          await settleQueuedFollowupPresentation(defaults.opts?.onQueuedFollowupSettled);
        }
      } finally {
        progressContinuation?.close();
      }
      for (const end of endDeliveryCorrelations.toReversed()) {
        try {
          end(
            // Source-owned batches settle through their own owner, whose void callback is not a receipt.
            disposition === "consumed" &&
              (!sourceRetryPending || visibleReplySent || completion.kind === "failed") &&
              sourceDisposition?.kind !== "deliver"
              ? {
                  visibleReplySent,
                  failed: !admittedTurn || completion.kind === "failed",
                  completed: Boolean(admittedTurn) && completion.kind === "completed",
                  ...(deliveryPending ? { transportPending: true } : {}),
                }
              : undefined,
          );
        } catch (error) {
          defaultRuntime.error?.(
            `followup queue: delivery correlation cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      if (disposition === "consumed") {
        completeFollowupRunLifecycle(queued);
      }
      try {
        await admittedTurn?.restartRecovery?.clear();
      } catch (error) {
        defaultRuntime.error?.(
          `followup queue: recovery settlement failed: ${formatErrorMessage(error)}`,
        );
      }
      if (disposition !== "deferred" && admittedTurn?.runId) {
        clearAgentRunContext(admittedTurn.runId);
      }
      operation?.complete();
      defaults.typing.markRunComplete();
      defaults.typing.markDispatchIdle();
    }
  };
  return runFollowup;
}
