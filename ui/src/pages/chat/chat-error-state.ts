export type ChatErrorState = ReturnType<typeof createChatErrorState>;

export function createChatErrorState() {
  let lastError: { message: string | null; detail?: unknown } = { message: null };
  let chatError: { message: string | null; detail?: unknown } = { message: null };
  let render: (() => void) | undefined;
  const publish = () => {
    render?.();
  };
  return {
    readErrors: () => ({
      lastError: lastError.message,
      lastErrorDetail: lastError.detail,
      chatError: chatError.message,
    }),
    subscribeErrors(listener: () => void) {
      render = listener;
      return () => {
        render = undefined;
      };
    },
    get lastError() {
      return lastError.message;
    },
    get lastErrorDetail() {
      return lastError.detail;
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
    setRecoverableChatError(message: string, detail?: unknown): () => void {
      const error = { message, detail };
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
