import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { LoadedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function prepareGoalChatSendRetry({
  request,
  session,
  context,
}: {
  request: NormalizedChatSendRequest;
  session: LoadedChatSendSession;
  context: GatewayRequestHandlerOptions["context"];
}) {
  if (!request.goalOperation) {
    return undefined;
  }
  const dedupe = context.dedupe.get(`chat:${session.clientRunId}`);
  try {
    const receipt = await lookupSessionGoalOperation({
      sessionKey: session.sessionKey,
      storePath: session.storePath,
      agentId: session.agentId,
      expectedSessionId:
        session.entry?.sessionId ?? session.backingSessionId ?? session.clientRunId,
      operation: request.goalOperation,
    });
    return { receipt, dedupe };
  } catch (error) {
    if (!(error instanceof SessionGoalOperationError)) {
      throw error;
    }
    return { receipt: error, dedupe };
  }
}
