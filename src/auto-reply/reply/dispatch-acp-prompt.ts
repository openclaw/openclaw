import { prefixSystemMessage } from "../../infra/system-message.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

export function resolveAcpTurnText(params: {
  promptText: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return params.promptText;
  }
  const guidance = prefixSystemMessage(
    [
      "Your final response is not automatically sent to this conversation for this turn.",
      "A visible reply requires the message tool. If available, use message(action=send) and follow its target requirements.",
      "Use final=false when more work or another reply must follow; finish the work before a final send with final=true. Do not repeat replies already delivered here.",
    ].join(" "),
  );
  return params.promptText ? `${guidance}\n\n${params.promptText}` : guidance;
}
