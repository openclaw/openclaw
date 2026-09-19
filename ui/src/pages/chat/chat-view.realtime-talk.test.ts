// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView } from "./chat-view.test-helpers.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("realtime Talk tail block gating", () => {
  it("does not render the realtime Talk block while the session is idle", () => {
    // Voice turns persist into history; once the realtime session goes idle the
    // unpinned tail block would render those earlier turns below newer typed
    // messages — out of chronological order. Idle turns must render only from
    // history, in their correct chronological slot.
    const container = renderChatView({
      realtimeTalkActive: false,
      realtimeTalkConversation: [
        { id: "u1", role: "user", text: "Turn off the lights", isStreaming: false },
        { id: "a1", role: "assistant", text: "Checking", isStreaming: false },
      ],
    });

    expect(container.querySelector(".agent-chat__voice-turns")).toBeNull();
    expect(container.querySelector(".agent-chat__voice-turn")).toBeNull();
  });

  it("renders realtime Talk transcript as ordered voice turns", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkConversation: [
        { id: "u1", role: "user", text: "Turn off the lights", isStreaming: false },
        { id: "a1", role: "assistant", text: "Checking", isStreaming: true },
        { id: "u2", role: "user", text: "Second request", isStreaming: false },
      ],
    });

    const turns = [...container.querySelectorAll(".agent-chat__voice-turn")];
    expect(turns.map((turn) => turn.getAttribute("data-role"))).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(turns.map((turn) => turn.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "You Turn off the lights",
      "Val Checking",
      "You Second request",
    ]);
    expect(container.querySelector(".chat-thread-inner .agent-chat__voice-turns")).not.toBeNull();
    expect(container.querySelector(".agent-chat__input .agent-chat__voice-turns")).toBeNull();
    expect(container.querySelector(".agent-chat__welcome")).toBeNull();
  });
});
