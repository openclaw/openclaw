import type { ReplyPayload } from "../types.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { enqueueGoalContinuation } from "./goal-continuation.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const accounting = await accountAgentTurn(context);
  const prepared = await prepareReplyAgentPayloads({ context, accounting });
  const result =
    prepared.kind === "return"
      ? prepared.value
      : await completeReplyAgentRun({ context, accounting, prepared });
  if (
    !context.isHeartbeat &&
    context.sessionKey &&
    context.storePath &&
    context.execution.status === "ok" &&
    accounting.activeSessionEntry?.goal?.status === "active"
  ) {
    await enqueueGoalContinuation({
      base: context.followupRun,
      result: accounting.runResult,
      initialGoalId: context.activeSessionEntry?.goal?.id,
      expectedSession: accounting.expectedSession,
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
