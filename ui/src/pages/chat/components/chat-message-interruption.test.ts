/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { handleChatGatewayEvent } from "../chat-gateway.ts";
import type { ChatState } from "../chat-state-contract.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import { createAssistantMessage, createMessageGroup } from "./chat-message.test-support.ts";

const container = document.createElement("div");
const view = createMessageGroupHarness(container);
afterEach(() => view.unmount());

function renderReply(message: unknown, isStreaming = false) {
  view.render(createMessageGroup(message, "assistant", { isStreaming }), {
    showReasoning: false,
  });
}

describe("interrupted assistant replies", () => {
  it.each([
    {
      name: "reloaded aborted",
      metadata: {
        openclawAbort: { aborted: true, origin: "rpc", runId: "stopped-run" },
        stopReason: "stop",
      },
      interrupted: true,
    },
    { name: "timed out", metadata: { stopReason: "timeout" }, interrupted: true },
    { name: "completed", metadata: { stopReason: "stop" }, interrupted: false },
  ])("marks $name replies from their recorded outcome", ({ metadata, interrupted }) => {
    renderReply(createAssistantMessage("From the earliest river", metadata));
    expect(container.querySelector(".chat-bubble")?.textContent).toContain(
      "From the earliest river",
    );
    expect(container.querySelector(".chat-bubble [role=status]")?.textContent?.trim() ?? null).toBe(
      interrupted ? "Interrupted" : null,
    );
  });

  it.each([
    {
      name: "assistant payload",
      message: createAssistantMessage([{ type: "text", text: "Partial reply" }]),
    },
    { name: "no payload", message: undefined },
  ])("marks a live stopped reply with $name", ({ message }) => {
    const state: ChatState = {
      client: null,
      connected: true,
      connectionEpoch: 0,
      sessionKey: "main",
      chatLoading: false,
      chatHistoryPagination: { hasMore: false },
      chatMessages: [],
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatSending: false,
      chatMessage: "",
      chatAttachments: [],
      chatQueue: [],
      chatRunId: "stopped-run",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      lastError: null,
      hello: null,
    };
    renderReply(createAssistantMessage(state.chatStream), true);
    expect(container.querySelector(".chat-bubble [role=status]")).toBeNull();

    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: "stopped-run",
      state: "aborted",
      message,
    });
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toHaveLength(1);
    renderReply(state.chatMessages[0]);
    expect(container.querySelector(".chat-bubble")?.textContent).toContain("Partial reply");
    expect(container.querySelector(".chat-bubble [role=status]")?.textContent?.trim()).toBe(
      "Interrupted",
    );
  });
});
