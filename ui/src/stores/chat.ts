import { create } from "zustand";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
}

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
  output?: string;
  status: "running" | "completed" | "error";
}

interface ChatState {
  messages: Map<string, ChatMessage[]>;
  streamingMessageId: string | null;

  setMessages: (sessionKey: string, messages: ChatMessage[]) => void;
  appendMessage: (sessionKey: string, message: ChatMessage) => void;
  updateMessage: (
    sessionKey: string,
    messageId: string,
    updates: Partial<ChatMessage>,
  ) => void;
  appendDelta: (sessionKey: string, messageId: string, text: string) => void;
  setStreamingMessageId: (id: string | null) => void;
  clearMessages: (sessionKey: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: new Map(),
  streamingMessageId: null,

  setMessages: (sessionKey, messages) =>
    set((state) => {
      const next = new Map(state.messages);
      next.set(sessionKey, messages);
      return { messages: next };
    }),
  appendMessage: (sessionKey, message) =>
    set((state) => {
      const next = new Map(state.messages);
      const existing = next.get(sessionKey) ?? [];
      next.set(sessionKey, [...existing, message]);
      return { messages: next };
    }),
  updateMessage: (sessionKey, messageId, updates) =>
    set((state) => {
      const next = new Map(state.messages);
      const existing = next.get(sessionKey) ?? [];
      next.set(
        sessionKey,
        existing.map((m) => (m.id === messageId ? { ...m, ...updates } : m)),
      );
      return { messages: next };
    }),
  appendDelta: (sessionKey, messageId, text) =>
    set((state) => {
      const next = new Map(state.messages);
      const existing = next.get(sessionKey) ?? [];
      next.set(
        sessionKey,
        existing.map((m) =>
          m.id === messageId ? { ...m, content: m.content + text } : m,
        ),
      );
      return { messages: next };
    }),
  setStreamingMessageId: (id) => set({ streamingMessageId: id }),
  clearMessages: (sessionKey) =>
    set((state) => {
      const next = new Map(state.messages);
      next.delete(sessionKey);
      return { messages: next };
    }),
}));
