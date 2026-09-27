/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("placement startup transcript cache", () => {
  it("reuses loaded history across fresh placement statuses and invalidates changed queue inputs", () => {
    const buildCachedChatItems = chatThread.buildCachedChatItems;
    let messageReads = 0;
    let historyBuildReads = 0;
    const loaded = new Proxy(
      {
        role: "assistant",
        content: "Loaded history",
        timestamp: 1,
        __openclaw: { id: "loaded", seq: 1 },
      },
      {
        get(target, key, receiver) {
          messageReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    vi.spyOn(chatThread, "buildCachedChatItems").mockImplementation((input) => {
      const before = messageReads;
      const items = buildCachedChatItems(input);
      historyBuildReads = messageReads - before;
      return items;
    });
    const initialTurn: ChatQueueItem = {
      id: "initial",
      text: "Original prompt",
      createdAt: 2,
      sendState: "failed",
      sendError: "Worker setup failed",
    };
    const queued: ChatQueueItem = { id: "later", text: "Later prompt", createdAt: 3 };
    const placementStartup = {
      sessionKey: "main",
      phase: "failed" as const,
      startedAt: 2,
      retryable: true,
      initialTurn,
    };
    const props = createChatProps({ messages: [loaded], queue: [queued], placementStartup });
    const container = document.createElement("div");
    render(renderChat(props), container);
    expect(historyBuildReads).toBeGreaterThan(0);

    render(renderChat({ ...props, placementStartup: { ...placementStartup } }), container);
    expect(historyBuildReads).toBe(0);

    render(
      renderChat({
        ...props,
        placementStartup: { ...placementStartup, initialTurn: { ...initialTurn } },
      }),
      container,
    );
    expect(historyBuildReads).toBeGreaterThan(0);

    render(renderChat(props), container);
    queued.sendState = "failed";
    render(renderChat({ ...props, queue: [...props.queue] }), container);
    expect(historyBuildReads).toBeGreaterThan(0);

    render(renderChat({ ...props, sessionKey: "agent:main:other" }), container);
    expect(historyBuildReads).toBeGreaterThan(0);
  });
});
