/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { mountChatThread } from "./components/chat-thread.test-support.ts";
import { emitTranscriptResize } from "./components/chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { getChatSessionScrollPosition } from "./scroll.ts";

let flushFrames: ReturnType<typeof stubAnimationFrames>;
beforeEach(() => {
  installTranscriptDomMocks();
  flushFrames = stubAnimationFrames();
});
afterEach(resetTranscriptTestDom);

async function mountSession(
  paneId: string,
  sessionKey: string,
  physicalSessionId: string | null = null,
  hasNewer = false,
  scrollHeight = 3_000,
) {
  const { pane, state } = createRefreshChatPane();
  pane.paneId = paneId;
  pane.presentationId = JSON.stringify([paneId, sessionKey]);
  state.sessionKey = sessionKey;
  state.connected = true;
  state.chatLoading = false;
  state.currentSessionId = physicalSessionId;
  if (hasNewer) {
    state.chatHistoryPagination = { ...state.chatHistoryPagination, hasNewer: true };
  }
  state.chatMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
    __openclaw: { id: `${sessionKey}:${index}` },
  }));
  pane.render();
  const props = expectDefined(pane.chatProps, "pane transcript props");
  state.chatScrollElement = () => props.transcript.scrollElement;
  props.transcript.start();
  const view = mountChatThread(props, props.transcript);
  const { container } = view;
  const thread = expectDefined(container.querySelector<HTMLDivElement>(".chat-thread"), "thread");
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
  thread.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      thread.scrollTop = Math.max(0, Math.min(options.top ?? thread.scrollTop, 2_400));
    }
  };
  props.transcript.update();
  thread.dispatchEvent(new Event("scroll"));
  await expect
    .poll(async () => {
      await Promise.resolve();
      flush();
      for (const row of thread.querySelectorAll<HTMLElement>(".chat-virtual-row")) {
        emitTranscriptResize(row, 800, row.offsetHeight);
      }
      flushFrames();
      flush();
      return props.transcript.isPositionSettled;
    })
    .toBe(true);
  return {
    thread,
    state,
    transcript: props.transcript,
    dispose: () => {
      props.transcript.dispose();
      view.unmount();
    },
  };
}

it("restores each physical pane's reader after visiting nine retained sessions", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 20));
  const firstSession = "agent:main:scroll-cache-0";
  const positions = [
    { paneId: "scroll-main", offset: 420 },
    { paneId: "scroll-detail", offset: 840 },
  ];
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    thread.scrollTop = offset;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    expect(thread.scrollTop).toBe(offset);
    dispose();
  }
  for (let index = 1; index < 9; index++) {
    const { thread, dispose } = await mountSession(
      "scroll-main",
      `agent:main:scroll-cache-${index}`,
    );
    thread.scrollTop = 200;
    thread.dispatchEvent(new Event("scroll"));
    dispose();
  }
  for (const { paneId, offset } of positions) {
    const { thread, dispose } = await mountSession(paneId, firstSession);
    expect.soft(thread.scrollTop).toBe(offset);
    dispose();
  }
});

it.each([
  { name: "reader", scrollTop: 420, hasNewer: false, anchorToEnd: false },
  { name: "detached-bottom", scrollTop: 2_400, hasNewer: true, anchorToEnd: false },
  { name: "true-tail-bottom", scrollTop: 2_400, hasNewer: false, anchorToEnd: true },
])(
  "saves source-aware reading position at $name",
  async ({ name, scrollTop, hasNewer, anchorToEnd }) => {
    const paneId = `semantic-scroll-${name}`;
    const sessionKey = `agent:main:${paneId}`;
    const { thread, dispose } = await mountSession(
      paneId,
      sessionKey,
      "scroll-physical-session",
      hasNewer,
    );
    const bubble = expectDefined(
      thread.querySelector<HTMLElement>("[data-message-id]"),
      "visible bubble",
    );
    thread.getBoundingClientRect = () => new DOMRect(0, 100, 800, 600);
    bubble.getBoundingClientRect = () => new DOMRect(0, 75, 800, 120);
    thread.scrollTop = scrollTop;
    thread.dispatchEvent(new Event("scroll"));
    const position = getChatSessionScrollPosition(paneId, sessionKey);
    expect(position?.anchorToEnd).toBe(anchorToEnd);
    if (anchorToEnd) {
      expect(position?.bookmark).toBeUndefined();
    } else {
      expect(position?.bookmark).toMatchObject({
        sessionId: "scroll-physical-session",
        messageKey: bubble.dataset.messageId,
        offset: -25,
      });
    }
    dispose();
  },
);

it.each([3_000, 600])(
  "publishes restored semantic reading ownership before automatic follow (range: %s)",
  async (scrollHeight) => {
    const paneId = "semantic-restore-follow-" + scrollHeight;
    const sessionKey = "agent:main:" + paneId;
    const first = await mountSession(paneId, sessionKey, "semantic-physical-session");
    const bubble = expectDefined(
      first.thread.querySelector<HTMLElement>("[data-message-id]"),
      "reader",
    );
    first.thread.getBoundingClientRect = () => new DOMRect(0, 100, 800, 600);
    bubble.getBoundingClientRect = () => new DOMRect(0, 75, 800, 120);
    first.thread.scrollTop = 420;
    first.thread.dispatchEvent(new Event("scroll"));
    expect(getChatSessionScrollPosition(paneId, sessionKey)?.bookmark?.messageKey).toBe(
      bubble.dataset.messageId,
    );
    first.dispose();

    const restored = await mountSession(
      paneId,
      sessionKey,
      "semantic-physical-session",
      false,
      scrollHeight,
    );
    try {
      expect(restored.state.chatReadingHistory).toBe(true);
      expect(restored.state.chatFollowLocked).toBe(true);
      expect(restored.transcript.scrollToEnd({ source: "auto" })).toBe(false);
    } finally {
      restored.dispose();
    }
  },
);
