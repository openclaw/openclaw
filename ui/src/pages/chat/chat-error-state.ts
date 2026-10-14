export type ChatErrorState = ReturnType<typeof createChatErrorState>;

export function createChatErrorState() {
  let lastError: { message: string | null } = { message: null };
  let chatError: { message: string | null } = { message: null };
  return {
    get lastError() {
      return lastError.message;
    },
    set lastError(message: string | null) {
      lastError = { message };
    },
    get chatError() {
      return chatError.message;
    },
    set chatError(message: string | null) {
      chatError = { message };
    },
    setRecoverableChatError(message: string): () => void {
      const error = { message };
      lastError = chatError = error;
      return () => {
        // Every assignment retires ownership, including another writer's identical message.
        if (lastError === error) {
          lastError = { message: null };
        }
        if (chatError === error) {
          chatError = { message: null };
        }
      };
    },
  };
}
