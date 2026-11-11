/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { mountChatThread } from "./components/chat-thread.test-support.ts";
import { emitTranscriptResize } from "./components/chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

let flushFrames: ReturnType<typeof stubAnimationFrames>;
beforeEach(() => {
  installTranscriptDomMocks();
  flushFrames = stubAnimationFrames();
});
afterEach(resetTranscriptTestDom);

async function mountSession(paneId: string, sessionKey: string) {
  const { pane, state } = createRefreshChatPane();
  pane.paneId = paneId;
  pane.presentationId = JSON.stringify([paneId, sessionKey]);
  state.sessionKey = sessionKey;
  state.connected = true;
  state.chatLoading = false;
  state.chatMessages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
    __openclaw: { id: `${sessionKey}:${index}` },
  }));
  pane.render();
  const props = expectDefined(pane.chatProps, "pane transcript props");
  props.transcript.start();
  const view = mountChatThread(props, props.transcript);
  const { container } = view;
  const thread = expectDefined(container.querySelector<HTMLDivElement>(".chat-thread"), "thread");
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 3_000 },
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
    dispose: () => {
      props.transcript.dispose();
      view.unmount();
    },
  };
}

it("restores each physical pane's reader after visiting nine retained sessions", async () => {
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
