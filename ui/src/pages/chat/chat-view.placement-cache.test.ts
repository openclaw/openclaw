/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, renderChatInto, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat transcript cache", () => {
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
    const container = createComposerContainer();
    renderChatPropsInto(container, props);
    expect(historyBuildReads).toBeGreaterThan(0);

    renderChatPropsInto(container, { ...props, placementStartup: { ...placementStartup } });
    expect(historyBuildReads).toBe(0);

    renderChatPropsInto(container, {
      ...props,
      placementStartup: { ...placementStartup, initialTurn: { ...initialTurn } },
    });
    expect(historyBuildReads).toBeGreaterThan(0);

    renderChatPropsInto(container, props);
    queued.sendState = "failed";
    renderChatPropsInto(container, { ...props, queue: [...props.queue] });
    expect(historyBuildReads).toBeGreaterThan(0);

    renderChatPropsInto(container, { ...props, sessionKey: "agent:main:other" });
    expect(historyBuildReads).toBeGreaterThan(0);
  });

  it("keeps multi-part run usage current when only output tokens change", () => {
    const runId = "run-composed";
    const group = (id: string, role: string, timestamp: number, message: unknown) => ({
      kind: "group",
      key: `group:${id}`,
      role,
      visibleContent: "text",
      messages: [{ key: `message:${id}`, message }],
      timestamp,
      isStreaming: false,
      ...(role === "user" ? {} : { runId }),
    });
    const user = group("user:run-composed", "user", 0, {
      role: "user",
      content: "Start the work.",
      timestamp: 0,
      __openclaw: { id: "user:run-composed", idempotencyKey: `${runId}:user` },
    });
    const assistant = group("assistant:run-start", "assistant", 1, {
      role: "assistant",
      content: "Starting the work.",
      timestamp: 1,
    });
    const tool = group("tool:run-work", "tool", 2, {
      role: "toolResult",
      content: "Tool complete.",
      timestamp: 2,
    });
    const reading = {
      kind: "reading-indicator",
      key: "reading:run-composed",
      startedAt: 1,
      runId,
    };
    vi.spyOn(chatThread, "buildCachedChatItems").mockReturnValue([
      user,
      assistant,
      tool,
      reading,
    ] as ReturnType<typeof chatThread.buildCachedChatItems>);
    const container = createComposerContainer();

    renderChatInto(container, {
      canAbort: true,
      runId,
      runUsageById: new Map([[runId, { outputTokens: 5_500, seq: 1 }]]),
      stream: null,
    });
    expect(container.querySelector(".chat-working-indicator__tokens")?.textContent).toContain(
      "5.5k",
    );
    renderChatInto(container, {
      canAbort: true,
      runId,
      runUsageById: new Map([[runId, { outputTokens: 7_200, seq: 2 }]]),
      stream: null,
    });

    expect(container.querySelector(".chat-working-indicator__tokens")?.textContent).toContain(
      "7.2k",
    );
  });
});
