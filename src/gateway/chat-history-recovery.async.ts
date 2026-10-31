import {
  prepareChatHistoryRecoveryFactsAsync,
  shouldOffloadChatText,
} from "./chat-display-projection.async.js";
import {
  createChatHistoryRecoveryProjection,
  type ChatHistoryRecoveryOptions,
} from "./chat-display-projection.core.js";

/** Keep incremental recovery state with the reader while preparing costly text facts off-thread. */
export function createAsyncChatHistoryRecoveryProjection(options?: ChatHistoryRecoveryOptions) {
  const recovery = createChatHistoryRecoveryProjection(options);
  return {
    async append(messages: unknown[]) {
      if (!shouldOffloadChatText(messages)) {
        recovery.append(messages);
        return;
      }
      const facts = await prepareChatHistoryRecoveryFactsAsync(messages, {
        ...options,
        assistantErrorPending: recovery.pending,
      });
      recovery.appendPrepared(facts.messages, facts.visible);
    },
    get pending() {
      return recovery.pending;
    },
  };
}
