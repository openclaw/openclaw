/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
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
      access: "suggest",
      actorState: "unknown",
      ts: 1_000,
    },
  });
  await draw();
  expect(container.querySelector(".chat-notice")?.textContent).toContain(
    "member-alice was invited with Suggest access",
  );
  expect(state.chatMessages).toEqual([]);
  state.connectionEpoch += 1;
  await draw();
  expect(container.querySelector(".chat-notice")).toBeNull();
});
