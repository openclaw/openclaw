import { chatRunBelongsToSelectedAgent } from "../chat-run-owner.js";
import type { ChatSendPreAdmissionParams } from "./chat-send-pre-admission.js";

/** Let an observed deadline commit its partial and outcome before history is read. */
export async function waitForChatSessionTimeoutPersistence({
  context,
  session,
}: Pick<ChatSendPreAdmissionParams, "context" | "session">): Promise<void> {
  // Call outside the session writer so terminal persistence can acquire it.
  for (const active of context.chatAbortControllers.values()) {
    if (
      active.sessionKey === session.sessionKey &&
      active.abortStopReason === "timeout" &&
      chatRunBelongsToSelectedAgent({ ...active, selectedAgentId: session.selectedAgent.agentId })
    ) {
      await active.projectSessionTerminalPersistence;
    }
  }
}
