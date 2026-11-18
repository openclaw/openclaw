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
      "Source channel delivery is private by default for this turn.",
      "Normal ACP final output will not be automatically posted to the source channel.",
      "To send visible output, use message(action=send). The target defaults to the current source channel.",
    ].join(" "),
  );
  return params.promptText ? `${guidance}\n\n${params.promptText}` : guidance;
}
