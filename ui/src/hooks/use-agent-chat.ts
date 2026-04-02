import { useCallback, useEffect } from "react";
import { useRPC } from "./use-rpc";
import { useEvent } from "./use-event";
import { useChatStore, type ChatMessage } from "@/stores/chat";

export function useAgentChat(sessionKey: string | null) {
  const rpc = useRPC();
  const store = useChatStore();

  const messages = sessionKey ? (store.messages.get(sessionKey) ?? []) : [];
  const isStreaming = store.streamingMessageId !== null;

  const loadHistory = useCallback(async () => {
    if (!sessionKey) return;
    const result = await rpc<{ messages: ChatMessage[] }>("chat.history", {
      sessionKey,
      limit: 100,
    });
    store.setMessages(sessionKey, result.messages);
  }, [rpc, sessionKey, store]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!sessionKey) return;

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        timestamp: new Date().toISOString(),
      };
      store.appendMessage(sessionKey, userMessage);

      const assistantMessageId = crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        timestamp: new Date().toISOString(),
        isStreaming: true,
      };
      store.appendMessage(sessionKey, assistantMessage);
      store.setStreamingMessageId(assistantMessageId);

      await rpc("chat.send", {
        sessionKey,
        message: content,
        deliver: true,
        idempotencyKey: userMessage.id,
      });
    },
    [rpc, sessionKey, store],
  );

  const handleChatEvent = useCallback(
    (payload: unknown) => {
      if (!sessionKey) return;
      const event = payload as {
        type: string;
        text?: string;
        message?: ChatMessage;
        error?: string;
        toolName?: string;
        params?: Record<string, unknown>;
        output?: string;
      };
      const streamingId = useChatStore.getState().streamingMessageId;

      switch (event.type) {
        case "delta":
          if (streamingId)
            store.appendDelta(sessionKey, streamingId, event.text ?? "");
          break;
        case "final":
          if (streamingId) {
            store.updateMessage(sessionKey, streamingId, {
              content: (event.message as ChatMessage)?.content ?? "",
              isStreaming: false,
            });
            store.setStreamingMessageId(null);
          }
          break;
        case "aborted":
          if (streamingId) {
            store.updateMessage(sessionKey, streamingId, {
              isStreaming: false,
            });
            store.setStreamingMessageId(null);
          }
          break;
        case "error":
          if (streamingId) {
            store.updateMessage(sessionKey, streamingId, {
              isStreaming: false,
              content: `Error: ${event.error ?? "Unknown error"}`,
            });
            store.setStreamingMessageId(null);
          }
          break;
        case "tool.start":
          if (streamingId) {
            store.updateMessage(sessionKey, streamingId, {
              toolCalls: [
                ...(useChatStore
                  .getState()
                  .messages.get(sessionKey)
                  ?.find((m) => m.id === streamingId)?.toolCalls ?? []),
                {
                  name: event.toolName ?? "",
                  params: event.params ?? {},
                  status: "running",
                },
              ],
            });
          }
          break;
        case "tool.output":
          // Update last tool call with output
          break;
      }
    },
    [sessionKey, store],
  );

  useEvent("chat", handleChatEvent);

  const abort = useCallback(async () => {
    if (!sessionKey) return;
    await rpc("chat.abort", { sessionKey });
  }, [rpc, sessionKey]);

  return { messages, isStreaming, sendMessage, abort, loadHistory };
}
