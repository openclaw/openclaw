// Shared feedback helpers for typing indicators, ack reactions, and status reactions.
export {
  removeAckReactionAfterReply,
  shouldAckReaction,
  shouldAckReactionForWhatsApp,
  type AckReactionGateParams,
  type AckReactionScope,
  type WhatsAppAckReactionMode,
} from "../channels/ack-reactions.js";
export { logAckFailure, logTypingFailure, type LogFn } from "../channels/logging.js";
export {
  CODING_TOOL_TOKENS,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  resolveToolEmoji,
  WEB_TOOL_TOKENS,
  type StatusReactionAdapter,
  type StatusReactionController,
  type StatusReactionEmojis,
  type StatusReactionTiming,
} from "../channels/status-reactions.js";
