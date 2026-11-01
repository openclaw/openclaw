import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { readChatSendRetryComparison } from "./chat-send-retry-comparison.js";
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
    const lookup = {
      sessionKey: session.sessionKey,
      storePath: session.storePath,
      agentId: session.agentId,
      expectedSessionId:
        session.entry?.sessionId ?? session.backingSessionId ?? session.clientRunId,
      operation: request.goalOperation,
    };
    let receipt = await lookupSessionGoalOperation(lookup);
    // A Goal receipt wins over transcript history; without one, an existing
    // ordinary input still owns its ID and cannot become a new Goal mutation.
    const comparison = receipt ? undefined : await readChatSendRetryComparison(session);
    if (comparison?.submitted) {
      // The atomic Goal admission may have committed while history was read.
      receipt = await lookupSessionGoalOperation(lookup);
    }
    return { receipt, dedupe, comparison };
  } catch (error) {
    if (!(error instanceof SessionGoalOperationError)) {
      throw error;
    }
    return { receipt: error, dedupe };
  }
}
