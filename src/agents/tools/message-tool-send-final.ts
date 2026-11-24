import { getAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { resolveMessageToolSourceReplyFinal } from "../embedded-agent-message-tool-source-reply.js";

/**
 * Resolves whether a `message(action=send)` ends the turn, scoped to the
 * assistant message of the tool call currently executing so a send batched
 * with other tool calls counts as progress.
 */
export function resolveExecutingMessageSendFinal(
  params: Record<string, unknown>,
  finalByDefault: boolean | undefined,
): boolean {
  const executingToolCall = getAgentToolExecutionContext();
  return resolveMessageToolSourceReplyFinal(params, finalByDefault, {
    assistantMessage: executingToolCall?.assistantMessage,
    toolCallId: executingToolCall?.toolCall.id,
  });
}
