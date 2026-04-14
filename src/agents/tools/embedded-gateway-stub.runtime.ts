/**
 * Runtime boundary for embedded-gateway-stub.
 *
 * Re-exports the heavy gateway modules so `embedded-gateway-stub.ts` can
 * dynamically import this single file instead of statically pulling in the
 * entire gateway → auto-reply → agents module graph (which would create an
 * import cycle back to `openclaw-tools.ts`).
 */
export { resolveSessionAgentId } from "../../agents/agent-scope.js";
export { loadConfig } from "../../config/config.js";
export { stripEnvelopeFromMessages } from "../../gateway/chat-sanitize.js";
export { augmentChatHistoryWithCliSessionImports } from "../../gateway/cli-session-history.js";
export { getMaxChatHistoryMessagesBytes } from "../../gateway/server-constants.js";
export {
  augmentChatHistoryWithCanvasBlocks,
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
  resolveEffectiveChatHistoryMaxChars,
  sanitizeChatHistoryMessages,
} from "../../gateway/server-methods/chat.js";
export { capArrayByJsonBytes } from "../../gateway/session-utils.fs.js";
export {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../../gateway/session-utils.js";
export type { SessionsListResult } from "../../gateway/session-utils.types.js";
