import type { ReplySessionBinding } from "../../auto-reply/reply/get-reply.types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { isChatAbortControllerEntryAbortable } from "../chat-abort.js";
import type { ChatAbortControllerEntry } from "../chat-abort.types.js";

// Native initialization may create the SID after admission. Only the original
// registration can adopt it; retained callbacks cannot bind a successor.
export function bindChatSendPreparedSession(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  clientRunId: string;
  sessionKey: string;
  sessionBinding: ChatAbortControllerEntry;
  lifecycleGeneration: string;
  admission: Pick<SessionWorkAdmissionLease, "isActive">;
  progressRefresh: boolean;
}): (binding: ReplySessionBinding) => void {
  const { sessionBinding } = params;
  return (binding) => {
    if (binding.sessionKey !== params.sessionKey) {
      return;
    }
    if (
      params.chatAbortControllers.get(params.clientRunId) !== sessionBinding ||
      params.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      !params.admission.isActive() ||
      !isChatAbortControllerEntryAbortable(sessionBinding) ||
      sessionBinding.registrationCleanupRequested ||
      // Refresh starts hidden; its presentation bit is not admission liveness.
      (sessionBinding.projectSessionActive === false && !params.progressRefresh) ||
      sessionBinding.projectSessionTerminalPending ||
      sessionBinding.projectSessionTerminalPersisted
    ) {
      throw createAbortError("chat session preparation no longer owns its admission");
    }
    sessionBinding.sessionId = binding.sessionId;
  };
}
