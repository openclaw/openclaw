import { describe, expect, it } from "vitest";
import {
  createRealtimeTalkConversationState,
  finishRealtimeConversationEntry,
  updateRealtimeTalkConversation,
} from "./realtime-talk-conversation.ts";

describe("realtime Talk conversation", () => {
  it("inserts spacing between adjacent transcript fragments", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Turn off",
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "the lights",
      final: false,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "Turn off the lights", isStreaming: true },
    ]);
  });

  it("keeps a late final rewrite in the original user bubble", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Can you tack",
      final: false,
      nowMs: 1,
    });
    state = finishRealtimeConversationEntry(state, "user", 2);
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Checking",
      final: false,
      nowMs: 3,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Can you check?",
      final: true,
      nowMs: 4,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "Can you check?", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: true },
    ]);
  });

  it("creates a new bubble for the next final user turn after assistant output starts", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "First request",
      final: false,
      nowMs: 1,
    });
    state = finishRealtimeConversationEntry(state, "user", 2);
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Checking",
      final: false,
      nowMs: 3,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Second request",
      final: true,
      nowMs: 4,
    });

    expect(state.entries).toMatchObject([
      { role: "user", text: "First request", isStreaming: false },
      { role: "assistant", text: "Checking", isStreaming: true },
      { role: "user", text: "Second request", isStreaming: false },
    ]);
  });
});
