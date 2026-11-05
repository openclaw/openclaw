import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { recordMessageToolRunOutcome } from "../../infra/message-tool-run-outcome-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { VisibleWorkSession } from "../get-reply-options.types.js";
import { prepareReplyTurnRunSource } from "./agent-runner-admission.js";
import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import { bindGoalContinuationExecution } from "./goal-continuation-return.js";
import { handoffCompletedSourceReply } from "./queue/drain.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import type { SessionEventExecution } from "./session-event-contract.js";
import { withVisibleWorkSessionReporter } from "./visible-work-sessions.js";

const messageToolOutcomeLog = createSubsystemLogger("auto-reply/message-tool-outcome");

async function recordAgentTurnExecutionOutcome(
  params: AgentTurnParams,
  result: AgentTurnExecutionResult | undefined,
): Promise<void> {
  if (result?.outcome.kind === "settled" && params.opts?.onVisibleWorkSessions) {
    const sessions = new Map<string, VisibleWorkSession>();
    for (const spawn of result.outcome.result.acceptedSessionSpawns ?? []) {
      if (spawn.sessionUrl && !sessions.has(spawn.childSessionKey)) {
        sessions.set(spawn.childSessionKey, {
          sessionKey: spawn.childSessionKey,
          url: spawn.sessionUrl,
          ...(spawn.publicRead === true ? { publicRead: true } : {}),
          ...(spawn.label ? { label: spawn.label } : {}),
        });
      }
    }
    if (sessions.size > 0) {
      await params.opts.onVisibleWorkSessions([...sessions.values()]);
    }
  }
  const executionStatus = resolveAgentTurnExecutionStatus(result?.outcome);
  if (
    executionStatus !== "cancelled" &&
    !(
      result?.outcome.kind === "rejected" &&
      resolveReplyOperationRunState(params.opts)?.replyCompletion?.outcome === "pending"
    )
  ) {
    params.opts?.onAgentRunTerminalOutcome?.(executionStatus === "ok" ? "completed" : "failed");
  }
  const sourceReplyDeliveryMode =
    params.followupRun.run.sourceReplyDeliveryMode ?? params.opts?.sourceReplyDeliveryMode;
  if (sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  const sessionKey = params.sessionKey ?? params.followupRun.run.sessionKey;
  if (!sessionKey) {
    messageToolOutcomeLog.warn("message-tool-only run outcome missing session key", {
      runId: result?.runId ?? params.opts?.runId,
      agentId: params.followupRun.run.agentId,
    });
    return;
  }
  const outcome = result?.outcome;
  const resolved =
    outcome?.kind === "settled" || outcome?.kind === "rejected" ? outcome.resolved : undefined;
  const runStatus: "completed" | "errored" | "aborted" =
    executionStatus === "ok" ? "completed" : executionStatus === "failed" ? "errored" : "aborted";
  const toolDelivered =
    outcome?.kind === "settled" && hasCompletedSourceReplyDeliveryEvidence(outcome.result);
  if (toolDelivered && executionStatus === "ok" && params.replyOperation) {
    handoffCompletedSourceReply(params.replyOperation, params.followupRun);
  }
  const values = {
    runId: result?.runId ?? params.opts?.runId ?? "unknown",
    sessionKey,
    agentId: params.followupRun.run.agentId,
    provider: resolved?.provider ?? params.followupRun.run.provider,
    model: resolved?.model ?? params.followupRun.run.model,
    outcome: toolDelivered ? ("tool_delivered" as const) : ("mute" as const),
    runStatus,
    occurredAt: Date.now(),
    storePath: params.storePath,
  };
  try {
    if (await recordMessageToolRunOutcome(values)) {
      messageToolOutcomeLog.info("recorded message-tool-only run outcome", values);
    }
  } catch (error) {
    messageToolOutcomeLog.warn("failed to record message-tool-only run outcome", {
      ...values,
      error: formatErrorMessage(error),
    });
  }
}

async function recordSessionEventTerminalOutcome(
  event: SessionEventExecution | undefined,
  runId: string,
  result: AgentTurnExecutionResult | undefined,
): Promise<void> {
  await event?.onTerminal(
    runId,
    result?.outcome.kind === "aborted"
      ? "aborted"
      : result?.outcome.kind === "settled" && result.outcome.status === "ok"
        ? "completed"
        : "failed",
    result?.outcome.kind === "settled"
      ? { ...result.outcome.result, resolved: result.outcome.resolved }
      : result?.outcome.kind === "rejected"
        ? { payloads: [result.outcome.payload], resolved: result.outcome.resolved }
        : undefined,
  );
}

/** Source custody settles native work before publishing the turn's terminal observations. */
export async function runAgentTurnWithOutcome(
  params: AgentTurnParams,
  runId: string,
  run: () => Promise<AgentTurnExecutionResult>,
): Promise<AgentTurnExecutionResult> {
  bindGoalContinuationExecution(runId, params.sessionKey ?? params.followupRun.run.sessionKey);
  const eventExecution = params.followupRun.run.internalEventExecution;
  const source = prepareReplyTurnRunSource(params, runId);
  let terminalRecorded = false;
  try {
    if (eventExecution) {
      eventExecution.assertCurrent?.();
      await eventExecution.beforeStart?.();
      params.replyOperation?.abortSignal.throwIfAborted();
      eventExecution.assertCurrent?.();
    }
    source.claim();
    const adapter = params.followupRun.controllerInput?.sourceAdapter;
    const result = await withExecRequestTurn(
      {
        identity: {
          runId,
          sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
          sessionId: params.followupRun.run.sessionId,
          agentId: params.followupRun.run.agentId,
          // Unbound event wakes inherit custody; absent fields must not erase its original actor.
          ...(adapter?.requester?.connectionId !== undefined
            ? { ownerConnId: adapter.requester.connectionId }
            : {}),
          ...(adapter?.requester?.deviceId !== undefined
            ? { ownerDeviceId: adapter.requester.deviceId }
            : {}),
          ...(adapter?.initiatingPersonalOperator
            ? { initiatingPersonalOperator: adapter.initiatingPersonalOperator }
            : {}),
          ...(adapter?.controlUiVisible !== undefined
            ? { controlUiVisible: adapter.controlUiVisible }
            : {}),
          ...(adapter?.turnKind ? { turnKind: adapter.turnKind } : {}),
        },
        owners: eventExecution?.execRequestOwners,
        abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
      },
      () =>
        withVisibleWorkSessionReporter(
          {
            requesterSessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
            report: params.opts?.onVisibleWorkSessions,
          },
          run,
        ),
    );
    const automation = params.followupRun.run.scheduledAutomation;
    const invocation = automation
      ? getAgentRunContext(runId)?.cronRunsByJobId?.get(automation.job.id)
      : undefined;
    if (automation && invocation) {
      invocation.closed = true;
      if (result.outcome.kind === "settled") {
        result.outcome.automation = {
          result: invocation.result,
          includeReasoning:
            automation.job.payload.kind === "agentTurn" &&
            automation.job.payload.includeReasoning === true,
        };
      }
    }
    await recordAgentTurnExecutionOutcome(params, result);
    terminalRecorded = true;
    await recordSessionEventTerminalOutcome(eventExecution, runId, result);
    return result;
  } catch (error) {
    eventExecution?.onFailed?.(error);
    if (!terminalRecorded) {
      await recordAgentTurnExecutionOutcome(params, undefined);
      await recordSessionEventTerminalOutcome(eventExecution, runId, undefined);
    }
    throw error;
  } finally {
    source.close();
  }
}
