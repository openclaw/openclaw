import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { enqueueGoalContinuation } from "./goal-continuation.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const initialGoalId = context.activeSessionEntry?.goal?.id;
  const { result, accounting: completedAccounting } = await withAgentTurnCompletion(
    {
      agentId: context.followupRun.run.agentId,
      storePath: context.storePath,
      sessionKey: context.sessionKey,
      entry: context.activeSessionEntry,
      writer: context.execution.sessionWriter,
      operation: context.replyOperation,
      prepareRestartClaimCleanup: context.prepareRestartClaimCleanup,
      publish(entry) {
        context.activeSessionEntry = entry;
        if (context.activeSessionStore && context.sessionKey) {
          context.activeSessionStore[context.sessionKey] = entry;
        }
      },
    },
    async (completion) => {
      const current = { ...context, completion };
      const accounting = await accountAgentTurn(current);
      const prepared = await prepareReplyAgentPayloads({ context: current, accounting });
      if (prepared.kind === "return") {
        const refreshDiagnostics =
          context.followupRun.run.verboseLevelOverride !== "off" ||
          context.followupRun.run.traceAuthorized === true;
        const activeSessionEntry =
          refreshDiagnostics && completion
            ? await completion.refresh()
            : accounting.activeSessionEntry;
        const diagnostics = await buildReplyDiagnosticsPayload({
          activeSessionEntry,
          followupRun: context.followupRun,
          accounting,
          cfg: context.cfg,
          storePath: context.storePath,
          userText: context.sessionCtx.commandText || context.sessionCtx.agentText,
          resolvedVerboseLevel: context.resolvedVerboseLevel,
          resolvedBlockStreamingBreak: context.resolvedBlockStreamingBreak,
          preflightCompactionApplied: context.preflightCompactionApplied,
        });
        await completion?.complete();
        if (!diagnostics) {
          return { result: prepared.value, accounting };
        }
        return {
          result: prepared.value
            ? [...(Array.isArray(prepared.value) ? prepared.value : [prepared.value]), diagnostics]
            : diagnostics,
          accounting,
        };
      }
      return {
        result: await completeReplyAgentRun({ context: current, accounting, prepared }),
        accounting,
      };
    },
  );
  if (
    !context.isHeartbeat &&
    context.sessionKey &&
    context.storePath &&
    context.execution.status === "ok" &&
    completedAccounting.activeSessionEntry?.goal?.status === "active"
  ) {
    await enqueueGoalContinuation({
      base: context.followupRun,
      result: completedAccounting.runResult,
      initialGoalId,
      expectedSession: completedAccounting.expectedSession,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      reader: getReplyOperationSessionReader(context.replyOperation),
      queueKey: context.queueKey,
      settings: context.resolvedQueue,
      sourceRunId: context.runId,
      operation: context.replyOperation,
      runFollowup: context.runFollowupTurn,
    });
  }
  return context.returnWithQueuedFollowupDrain(result);
}
