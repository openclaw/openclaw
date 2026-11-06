/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { loadChatHistory, restoreChatHistoryBookmark } from "../chat-history.ts";
import { makeChatHost } from "../chat-host.test-support.ts";
import { nativeHistoryMessage } from "../chat-pane-history.test-support.ts";
import { residentPane } from "../chat-pane-resident.test-support.ts";
import type { ChatHost } from "../chat-send-contract.ts";
import { handleSendChat } from "../chat-send-submit.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  handleChatScrollTakeover,
  hasPendingManualChatScroll,
  saveChatSessionScrollPosition,
  type ChatReadingBookmark,
} from "../scroll.ts";
import {
  mountTestTranscript,
  numberedContentRows,
} from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

let frames: ReturnType<typeof stubAnimationFrames>;
beforeEach(() => {
  installTranscriptDomMocks();
  frames = stubAnimationFrames();
});
afterEach(resetTranscriptTestDom);

async function mountHeldBookmark(paneId: string, state: ChatHost) {
  await loadChatHistory(state);
  const message = nativeHistoryMessage(80, "body-80");
  Object.assign(message["__openclaw"], { id: "source-80" });
  const saved: ChatReadingBookmark = {
    sessionId: "resident-session",
    source: "id:source-80",
    messageId: "source-80",
    messageKey: buildMessageItems([message])[0]!.key,
    rowKey: null,
    offset: -25,
  };
  saveChatSessionScrollPosition(paneId, `agent:main:${paneId}`, {
    scrollTop: 420,
    anchorToEnd: false,
    bookmark: saved,
  });
  const held = createDeferred<boolean>();
  const client = state.client!;
  const request = client.request.bind(client);
  let requested = false;
  client.request = async (...args) => {
    requested = true;
    if (!(await held.promise)) {
      throw new Error("Bookmark read interrupted");
    }
    return request(...args);
  };
  let restoring: Promise<boolean | undefined> | undefined;
  const restore = vi.fn((bookmark: typeof saved, isCurrent: () => boolean) => {
    restoring = restoreChatHistoryBookmark(state, bookmark, isCurrent);
    return restoring;
  });
  const transcript = createChatTranscript(() => paneId, {
    getSessionId: () => state.currentSessionId ?? null,
    restoreBookmark: restore,
    hasPendingScrollCommand: () => hasPendingManualChatScroll(state),
    onReaderScroll: (towardEnd) => handleChatScrollTakeover(state, towardEnd),
  });
  state.chatCancelScroll = () => transcript.cancelScroll();
  state.chatScrollToEnd = (options) => transcript.scrollToEnd(options);
  state.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
  state.chatIsMaintenanceScroll = () => transcript.isMaintenanceScroll;
  const view = await mountTestTranscript(paneId, numberedContentRows(20), transcript);
  state.chatScrollElement = () => view.container;
  view.session.layout.ready = true;
  transcript.update();
  await waitForSolid(() => {
    expect(restore).toHaveBeenCalledOnce();
    expect(requested).toBe(true);
  });
  return { state, transcript, view, held, restore, saved, result: () => restoring! };
}

async function heldBookmark(paneId: string) {
  const { state } = residentPane();
  return { ...(await mountHeldBookmark(paneId, state)), state };
}

it.each(["Latest", "reader takeover"])(
  "retires a held bookmark at %s intent before deferred scrolling",
  async (action) => {
    const { state, transcript, view, held, result } = await heldBookmark(`bookmark-${action}`);
    const retained = state.chatMessages;
    if (action === "Latest") {
      state.scrollToBottom();
    } else {
      view.container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    }
    // Settle before afterCommit/rAF, so deferred scroll cannot supply the fence.
    held.resolve(true);
    expect(await result()).toBe(false);
    expect(state.chatMessages).toBe(retained);
    expect(state.lastError).toBeNull();
    transcript.dispose();
  },
);

it("settles a disconnected bookmark and allows the same host to reconnect", async () => {
  const { transcript, view, held, result, restore } = await heldBookmark("bookmark-reconnect");
  transcript.dispose();
  held.resolve(false);
  expect(await result()).toBe(false);
  transcript.start();
  view.renderRows(numberedContentRows(20));
  frames();
  flush();
  await waitForSolid(() => expect(transcript.isPositionSettled).toBe(true));
  expect(restore).toHaveBeenCalledOnce();
  transcript.dispose();
});

it.each(["response before layout", "layout before response"] as const)(
  "Send retires saved bookmark custody before its first manual frame: %s",
  async (order) => {
    const paneId = `bookmark-send-${order}`;
    const sendGate = createDeferred();
    const host = makeChatHost({
      sessionKey: `agent:main:${paneId}`,
      currentSessionId: "resident-session",
      requestHandlers: {
        "chat.history": ({ messageId }: { messageId?: string }) => {
          const seq = messageId ? 80 : 640;
          const message = nativeHistoryMessage(seq, `body-${seq}`);
          Object.assign(message["__openclaw"], { id: `source-${seq}` });
          return { messages: [message], sessionId: "resident-session" };
        },
        "chat.send": async () => {
          await sendGate.promise;
          return { runId: "bookmark-send", status: "ok" };
        },
      },
    });
    const { state, transcript, view, held, saved, result } = await mountHeldBookmark(paneId, host);
    const sending = handleSendChat(state, "Send from the restored pane");
    try {
      await waitForSolid(() => expect(hasPendingManualChatScroll(state)).toBe(true));
      const retained = state.chatMessages;
      if (order === "layout before response") {
        // The old saved row becomes measurable after Send has already queued its command.
        view.session.syncMessageRows(
          new Map([[saved.messageId, "row:0"]]),
          new Map([[saved.messageKey, "row:0"]]),
        );
        view.renderRows(numberedContentRows(20));
        await flushDeferredRowPrune();
        expect(hasPendingManualChatScroll(state)).toBe(true);
      }
      held.resolve(true);
      const restored = await result();
      expect(restored).toBe(false);
      expect(state.chatMessages).toBe(retained);
      expect(hasPendingManualChatScroll(state)).toBe(true);
      expect(state.lastError).toBeNull();
      view.container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      expect(hasPendingManualChatScroll(state)).toBe(false);
    } finally {
      transcript.dispose();
      held.resolve(true);
      sendGate.resolve();
      await sending;
    }
  },
);
