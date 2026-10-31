export type ChatErrorState = ReturnType<typeof createChatErrorState>;

export function createChatErrorState() {
  let lastError: { message: string | null } = { message: null };
  let chatError: { message: string | null } = { message: null };
  let render: (() => void) | undefined;
  const publish = () => {
    render?.();
  };
  return {
    readErrors: () => ({ lastError: lastError.message, chatError: chatError.message }),
    subscribeErrors(listener: () => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
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
