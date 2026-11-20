/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { createSessionEventState } from "./chat-state.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import { render, renderChatThread } from "./test-helpers/chat-transcript-native.tsx";

let transcript: ReturnType<typeof createTestTranscript> | undefined;
beforeEach(installTranscriptDomMocks);
afterEach(() => {
  transcript?.dispose();
  transcript = undefined;
  resetTranscriptTestDom();
});

it("renders live sharing events through the transcript notice owner and clears on reconnect", async () => {
  const { state } = createSessionEventState();
  const props = threadProps("sharing-notices", state.sessionKey, state.chatMessages, {
    historyState: state,
    currentAgentId: "main",
  });
  transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const draw = async () => {
    render(renderChatThread(props, transcript!), container);
    await flushDeferredRowPrune();
  };
  await draw();
  expect(container.querySelector(".chat-notice")).toBeNull();
  handlePageGatewayEvent(state, {
    type: "event",
    event: "session.sharing.evidence",
    payload: {
      sessionKey: state.sessionKey,
      agentId: "main",
      action: "member-added",
      identityId: "member-alice",
      identityLabel: "Alice Collaborator",
      access: "suggest",
      actorState: "unknown",
      ts: 1_000,
    },
  });
  await draw();
  expect(container.querySelector(".chat-notice")?.textContent).toContain(
    "Alice Collaborator was invited with Suggest access",
  );
  expect(state.chatMessages).toEqual([]);
  state.connectionEpoch += 1;
  await draw();
  expect(container.querySelector(".chat-notice")).toBeNull();
});

it("keeps delayed sharing events between timestamped messages as history grows", async () => {
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(2_000);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 2_000),
  );
  const messages = [
    { role: "assistant", content: "Earlier reply", timestamp: 1_000 },
    { role: "assistant", content: "Later reply", timestamp: 3_000 },
  ];
  const { state } = createSessionEventState({ chatMessages: messages });
  const props = threadProps("sharing-order", state.sessionKey, messages, {
    historyState: state,
    currentAgentId: "main",
  });
  transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  const draw = async () => {
    render(renderChatThread(props, transcript!), container);
    await flushDeferredRowPrune();
  };
  await draw();
  for (const [ts, identityLabel] of [
    [2_000, "Second"],
    [1_500, "First"],
    [500, "Before"],
    [4_000, "Tail"],
  ] as const) {
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.sharing.evidence",
      payload: {
        sessionKey: state.sessionKey,
        agentId: "main",
        action: "member-access-changed",
        identityId: identityLabel,
        identityLabel,
        access: "suggest",
        actorState: "unknown",
        ts,
      },
    });
  }
  await draw();
  transcript.scrollToOffset(0);
  await flushDeferredRowPrune();
  const order = () =>
    [...container.querySelectorAll(".chat-notice, .chat-bubble")].map((row) => row.textContent);

  const expected = [
    "Before’s access",
    "Earlier reply",
    "First’s access",
    "Second’s access",
    "Later reply",
    "Tail’s access",
  ];
  expect(order()).toEqual(expected.map((text) => expect.stringContaining(text)));
  state.chatMessages = [...messages, { role: "user", content: "Newest message", timestamp: 5_000 }];
  props.messages = state.chatMessages;
  await draw();
  expect(order()).toEqual(
    [...expected, "Newest message"].map((text) => expect.stringContaining(text)),
  );
  expect(state.chatMessages).toHaveLength(3);
  state.connectionEpoch += 1;
  await draw();
  expect(container.querySelector(".chat-notice")).toBeNull();
});
