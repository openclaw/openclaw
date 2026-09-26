/**
 * Runtime dependency barrel for the embedded Gateway stub.
 *
 * Tests mock this module to exercise local sessions.list/sessions.resolve/sessions.search/chat.history
 * behavior without importing the full Gateway server graph.
 */
export { resolveSessionAgentId } from "../../agents/agent-scope.js";
export { resolveSessionModelRef } from "../session-model-ref.js";
export { getRuntimeConfig } from "../../config/config.js";
export { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
export { resolveTranscriptSessionKeyBySessionId } from "../../config/sessions/session-accessor.js";
export { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
export {
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
export { resolveEffectiveChatHistoryMaxChars } from "../../gateway/chat-display-projection.js";
export { getMaxChatHistoryMessagesBytes } from "../../gateway/server-constants.js";
export {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "../../gateway/server-methods/chat-history-budget.js";
export {
  capChatHistoryAroundMessage,
  resolveChatHistoryNextOffset,
} from "../../gateway/server-methods/chat-history-page-kernel.js";
export { readChatHistoryPage } from "../../gateway/server-methods/chat-history-pages.js";
export { capArrayByJsonBytes } from "../../gateway/session-transcript-readers.js";
export { listProjectedSessions } from "../../gateway/session-utils-list.js";
export { loadGatewaySessionEntryReadOnly as loadSessionEntry } from "../../gateway/session-utils-store.js";
export { withPreparedSessionResolve } from "../../gateway/sessions-resolve.js";
export type { SessionsListResult } from "../../gateway/session-utils.types.js";
