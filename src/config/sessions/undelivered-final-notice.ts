export const MESSAGE_TOOL_ONLY_UNDELIVERED_FINAL_CUSTOM_TYPE =
  "openclaw.message-tool-only-undelivered-final";

export const MESSAGE_TOOL_ONLY_UNDELIVERED_FINAL_NOTICE =
  "OpenClaw delivery notice: the preceding assistant reply was not delivered to the user. " +
  "This lane is configured with message_tool_only, so only replies sent through the message tool reach the source channel. " +
  "Treat the preceding assistant reply as private context, not as text the user saw or approved.";

export type MessageToolOnlyUndeliveredFinalNoticeDetails = {
  sourceReplyDeliveryMode: "message_tool_only";
  delivered: false;
  finalTextLength: number;
};
