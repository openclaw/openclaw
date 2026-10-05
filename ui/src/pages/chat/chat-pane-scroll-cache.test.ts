/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  stubAnimationFrames();
});
afterEach(resetTranscriptTestDom);

function mountSession(paneId: string, sessionKey: string) {
  const { pane, state } = createRefreshChatPane();
  pane.paneId = paneId;
  pane.presentationId = JSON.stringify([paneId, sessionKey]);
  state.sessionKey = sessionKey;
  state.chatMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
    __openclaw: { id: `${sessionKey}:${index}` },
  }));
  pane.render();
  const props = expectDefined(pane.chatProps, "pane transcript props");
  const container = document.body.appendChild(document.createElement("div"));
  props.transcript.hostConnected();
  render(renderChatThread(props, props.transcript), container);
  const thread = expectDefined(container.querySelector<HTMLDivElement>(".chat-thread"), "thread");
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 3_000 },
  });
  props.transcript.hostUpdated();
  return {
    thread,
    dispose: () => {
      props.transcript.hostDisconnected();
      render(nothing, container);
      container.remove();
    },
  };
}

it("restores each physical pane's reader after visiting nine retained sessions", () => {
  const firstSession = "agent:main:scroll-cache-0";
  const positions = [
    { paneId: "scroll-main", offset: 420 },
    { paneId: "scroll-detail", offset: 840 },
  ];
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = mountSession(paneId, firstSession);
    thread.scrollTop = offset;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = mountSession(paneId, firstSession);
    expect(thread.scrollTop).toBe(offset);
    dispose();
  }
  for (let index = 1; index < 9; index++) {
    const { thread, dispose } = mountSession("scroll-main", `agent:main:scroll-cache-${index}`);
    thread.scrollTop = 200;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = mountSession(paneId, firstSession);
    expect.soft(thread.scrollTop).toBe(offset);
    dispose();
  }
});
