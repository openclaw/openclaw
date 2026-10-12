import type { AgentMessage } from "../agents/runtime/index.js";
import { isReadableSessionMessage } from "../config/sessions/session-entry-codec.js";

/**
 * Accepts the message a synchronous transcript hook returned.
 *
 * `tool_result_persist` and `before_message_write` rewrite the entry the host is
 * about to persist, so a replacement the transcript cannot store must fail that
 * hook result instead of aborting the write. The runner reports the failure
 * against the owning plugin and keeps the message the hook received.
 */
export function resolveSyncMessageReplacement(
  message: AgentMessage | undefined,
): { message: AgentMessage } | undefined {
  if (!message) {
    return undefined;
  }
  if (!isReadableSessionMessage(message)) {
    throw new Error("the replacement is not a session message; the original message was kept");
  }
  return { message };
}
