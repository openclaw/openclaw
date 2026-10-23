import type { ReplyPayload } from "../types.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { enqueueGoalContinuation } from "./goal-continuation.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const initialGoalId = context.activeSessionEntry?.goal?.id;
  const accounting = await accountAgentTurn(context);
  const prepared = await prepareReplyAgentPayloads({ context, accounting });
  let result: ReplyPayload | ReplyPayload[] | undefined;
  if (prepared.kind === "return") {
    result = prepared.value;
  } else {
    result = await completeReplyAgentRun({ context, accounting, prepared });
  }
  if (
    !context.isHeartbeat &&
    context.sessionKey &&
    context.storePath &&
    context.execution.status === "ok"
  ) {
    await enqueueGoalContinuation({
      base: context.followupRun,
      result: accounting.runResult,
      initialGoalId,
      expectedSession: accounting.expectedSession,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      queueKey: context.queueKey,
      settings: context.resolvedQueue,
      sourceRunId: context.runId,
      operation: context.replyOperation,
      runFollowup: context.runFollowupTurn,
    });
  }
  return result;
}
