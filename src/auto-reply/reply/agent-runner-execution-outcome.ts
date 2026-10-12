import { hasCompletedSourceReplyDeliveryEvidence } from "../../agents/embedded-agent-runner/delivery-evidence.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withExecRequestTurn } from "../../infra/exec-request-context.js";
import { recordMessageToolRunOutcome } from "../../infra/message-tool-run-outcome-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { VisibleWorkSession } from "../get-reply-options.types.js";
import { resolveAgentTurnExecutionStatus } from "./agent-runner-execution-status.js";
import type { AgentTurnExecutionResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import type { SessionEventExecution } from "./session-event-contract.js";
import { getReplySystemEventContext } from "./system-event-session-key.js";

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
      params.opts.onVisibleWorkSessions([...sessions.values()]);
    }
  }
  const executionStatus = resolveAgentTurnExecutionStatus(result?.outcome);
  if (executionStatus !== "cancelled") {
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
    await recordMessageToolRunOutcome(values);
    messageToolOutcomeLog.info("recorded message-tool-only run outcome", values);
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
  );
}

/** Source custody settles native work before publishing the turn's terminal observations. */
export async function runAgentTurnWithOutcome(
  params: AgentTurnParams,
  runId: string,
  run: () => Promise<AgentTurnExecutionResult>,
): Promise<AgentTurnExecutionResult> {
  const eventExecution = params.followupRun.run.internalEventExecution;
  let terminalRecorded = false;
  try {
    if (eventExecution) {
      eventExecution.assertCurrent?.();
      await eventExecution.beforeStart?.();
      params.replyOperation?.abortSignal.throwIfAborted();
      eventExecution.assertCurrent?.();
    }
    const result = await withExecRequestTurn(
      {
        identity: {
          runId,
          sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
          sessionId: params.followupRun.run.sessionId,
          agentId: params.followupRun.run.agentId,
        },
        owners:
          eventExecution?.execRequestOwners ??
          getReplySystemEventContext(params.opts)?.execRequestOwners,
        abortSignal: params.replyOperation?.abortSignal ?? params.opts?.abortSignal,
      },
      run,
    );
    await recordAgentTurnExecutionOutcome(params, result);
    terminalRecorded = true;
    await recordSessionEventTerminalOutcome(eventExecution, runId, result);
    return result;
  } catch (error) {
    if (!terminalRecorded) {
      await recordAgentTurnExecutionOutcome(params, undefined);
      await recordSessionEventTerminalOutcome(eventExecution, runId, undefined);
    }
    throw error;
  }
}
