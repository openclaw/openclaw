export function createControlUiChatHistoryMessage(
  role: "assistant" | "user",
  text: string,
  timestamp: number,
) {
  return {
    content: [{ text, type: "text" }],
    role,
    timestamp,
  };
}
