import { registerListener } from "../../../../src/shared/listeners.js";

export type ChatErrorState = ReturnType<typeof createChatErrorState>;

export function createChatErrorState() {
  let lastError: { message: string | null } = { message: null };
  let chatError: { message: string | null } = { message: null };
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    readErrors: () => ({ lastError: lastError.message, chatError: chatError.message }),
    subscribeErrors: (listener: () => void) => registerListener(listeners, listener),
    get lastError() {
      return lastError.message;
    },
    set lastError(message: string | null) {
      lastError = { message };
      publish();
    },
    get chatError() {
      return chatError.message;
    },
    set chatError(message: string | null) {
      chatError = { message };
      publish();
    },
    setRecoverableChatError(message: string): () => void {
      const error = { message };
      lastError = chatError = error;
      publish();
      return () => {
        // Every assignment retires ownership, including another writer's identical message.
        let cleared = false;
        if (lastError === error) {
          lastError = { message: null };
          cleared = true;
        }
        if (chatError === error) {
          chatError = { message: null };
          cleared = true;
        }
        if (cleared) {
          publish();
        }
      };
    },
  };
}
