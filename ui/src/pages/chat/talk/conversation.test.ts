// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
} from "./conversation.ts";

describe("realtime Talk conversation", () => {
  it("carries the durable relay identity when a preview becomes final", () => {
    let state = createRealtimeTalkConversationState();
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Hello",
      final: false,
      textMode: "snapshot",
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "Hello there",
      final: true,
      transcriptId: "voice:call:1",
    });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      text: "Hello there",
      transcriptId: "voice:call:1",
      isStreaming: false,
    });
  });
  it("keeps a corrected snapshot before the answer without adding another user entry", () => {
    let state = createRealtimeTalkConversationState();
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "How",
      final: false,
      textMode: "snapshot",
    });
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Earth is",
      final: false,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "What size is Earth?",
      final: false,
      textMode: "snapshot",
    });
    state = updateRealtimeTalkConversation(state, {
      role: "user",
      text: "What size is Earth?",
      final: true,
      textMode: "snapshot",
    });
    expect(state.entries).toMatchObject([
      { role: "user", text: "What size is Earth?", isStreaming: false },
      { role: "assistant", text: "Earth is" },
    ]);
  });

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

  it("appends a final assistant fragment that only carries the transcript tail", () => {
    let state = createRealtimeTalkConversationState();

    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "Sure, the lights are ",
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "off now.",
      final: true,
      nowMs: 2,
    });

    expect(state.entries).toMatchObject([
      { role: "assistant", text: "Sure, the lights are off now.", isStreaming: false },
    ]);
  });

  it("bounds streamed assistant delta growth while retaining useful context", () => {
    let state = createRealtimeTalkConversationState();
    const opening = "Opening context stays visible. ";

    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: `${opening}${"a".repeat(7_900)}`,
      final: false,
      nowMs: 1,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: "b".repeat(500),
      final: false,
      nowMs: 2,
    });
    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: `${"c".repeat(500)}NEWEST`,
      final: false,
      nowMs: 3,
    });

    expect(state.entries[0]?.text.length).toBeLessThanOrEqual(8_000);
    expect(state.entries[0]?.text.startsWith(opening)).toBe(true);
    expect(state.entries[0]?.text).toContain("\n…\n");
    expect(state.entries[0]?.text.split("\n…\n")).toHaveLength(2);
    expect(state.entries[0]?.text.endsWith("NEWEST")).toBe(true);
  });

  it("replaces a bounded assistant stream with the authoritative final transcript", () => {
    let state = createRealtimeTalkConversationState();
    const opening = "Original opening context. ";

    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: `${opening}${"draft ".repeat(1_600)}`,
      final: false,
      nowMs: 1,
    });
    expect(state.entries[0]?.text).toContain("\n…\n");

    state = updateRealtimeTalkConversation(state, {
      role: "assistant",
      text: `${opening}corrected ${"final ".repeat(1_600)}DONE`,
      final: true,
      nowMs: 2,
    });

    expect(state.entries[0]?.text.length).toBeLessThanOrEqual(8_000);
    expect(state.entries[0]?.text.startsWith(`${opening}corrected `)).toBe(true);
    expect(state.entries[0]?.text).not.toContain("draft ");
    expect(state.entries[0]?.text.endsWith("DONE")).toBe(true);
    expect(state.entries[0]?.isStreaming).toBe(false);
  });
});
