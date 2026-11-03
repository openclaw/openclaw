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
      "Your final response is not automatically sent here for this turn.",
      "Visible text replies require message(action=send); follow its target requirements. Without that tool, you cannot send a reply here.",
      "Use final=false for chat updates and mid-task answers, then continue working. Finish the work before a final send with final=true. Do not repeat replies already delivered here.",
    ].join(" "),
  );
  return params.promptText ? `${guidance}\n\n${params.promptText}` : guidance;
}
