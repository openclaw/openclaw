// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createState, createTextChatMessage } from "./chat-gateway.test-support.ts";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";

describe("chat snapshot projection boundaries", () => {
  it.each([
    [
      "raw prefix scaffolding",
      "Visible",
      " reply",
      "<think>hidden</think>Visible reply",
      "Visible reply",
    ],
    [
      "appended scaffolding",
      "Visible",
      "<think>hidden</think> reply",
      "Visible<think>hidden</think> reply",
      "Visible reply",
    ],
    [
      "split model token",
      "Visible <|assi",
      "stant|> reply",
      "Visible <|assistant|> reply",
      "Visible  reply",
    ],
    [
      "long memory opener",
      `<relevant-memories data-proof="${"x".repeat(300)}"`,
      ">hidden",
      `<relevant-memories data-proof="${"x".repeat(300)}">hidden`,
      "",
    ],
    [
      "long trace opener",
      `tool_call${" ".repeat(300)}`,
      ": hidden\nVisible",
      `tool_call${" ".repeat(300)}: hidden\nVisible`,
      "Visible",
    ],
    [
      "punctuation-free long trace opener",
      `🛠️${" ".repeat(300)}`,
      "git status\nVisible",
      `🛠️${" ".repeat(300)}git status\nVisible`,
      "Visible",
    ],
  ])("projects %s", (_name, previous, delta, snapshot, expected) => {
    const state = createState({ chatRunId: "run-1", chatStream: previous });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: delta,
      message: createTextChatMessage("assistant", snapshot),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe(expected);
  });
});
