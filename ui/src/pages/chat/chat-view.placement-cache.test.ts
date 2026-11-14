/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { nativeMessage } from "./chat-thread-fixtures.test-support.ts";
import * as chatThread from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
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
      nativeMessage("assistant", "Loaded history", 1, { id: "loaded", seq: 1 }),
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
    const group = (id: string, role: string, timestamp: number, content: string) => ({
      kind: "group",
      key: `group:${id}`,
      role,
      visibleContent: "text",
      messages: [
        {
          key: `message:${id}`,
          message: {
            role,
            content,
            timestamp,
            ...(role === "user" ? { __openclaw: { id, idempotencyKey: `${runId}:user` } } : {}),
          },
        },
      ],
      timestamp,
      isStreaming: false,
      ...(role === "user" ? {} : { runId }),
    });
    const user = group("user:run-composed", "user", 0, "Start the work.");
    const assistant = group("assistant:run-start", "assistant", 1, "Starting the work.");
    const tool = { ...group("tool:run-work", "toolResult", 2, "Tool complete."), role: "tool" };
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

    const drawUsage = (outputTokens: number, seq: number) =>
      renderChatInto(container, {
        canAbort: true,
        runId,
        stream: null,
        runUsageById: new Map([[runId, { outputTokens, seq }]]),
      });
    const tokens = () => container.querySelector(".chat-working-indicator__tokens")?.textContent;
    drawUsage(5_500, 1);
    expect(tokens()).toContain("5.5k");
    drawUsage(7_200, 2);
    expect(tokens()).toContain("7.2k");
  });
});
