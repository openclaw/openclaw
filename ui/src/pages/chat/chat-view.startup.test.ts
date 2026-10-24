/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createTestTranscript, renderChatView } from "./chat-view.test-helpers.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { saveChatSessionScrollPosition } from "./scroll.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("initial chat delivery controls", () => {
  it.each([
    { connected: false, recorded: false },
    { connected: false, recorded: true },
    { connected: true, recorded: true },
  ])(
    "keeps the pending initial turn discardable without Retry (%o)",
    async ({ connected, recorded }) => {
      const onRetrySessionPlacementStartup = vi.fn();
      const onDiscardSessionPlacementStartup = vi.fn();
      const container = renderChatView({
        connected,
        canSend: false,
        messages: recorded
          ? [
              {
                role: "user",
                content: "pending prompt",
                __openclaw: { idempotencyKey: "initial:user" },
              },
            ]
          : [],
        placementStartup: {
          sessionKey: "main",
          targetKind: "profile",
          phase: connected ? "sending" : "reconnecting",
          startedAt: 1,
          initialTurn: {
            id: "initial",
            sendRunId: "initial",
            text: "pending prompt",
            createdAt: 1,
            sendAttempts: 1,
            sendState: connected ? "sending" : "waiting-reconnect",
          },
        },
        onRetrySessionPlacementStartup,
        onDiscardSessionPlacementStartup,
      });
      await flushDeferredRowPrune();
      expect(container.querySelectorAll(".chat-group.user")).toHaveLength(1);
      expect(container.querySelectorAll(".chat-send-status")).toHaveLength(1);
      const status = container.querySelector(".chat-send-status");
      expect(status?.textContent).toContain(connected ? "Queued" : "Waiting for reconnect");
      expect(status?.querySelector(".chat-send-status__retry")).toBeNull();
      status?.querySelector<HTMLButtonElement>(".chat-send-status__discard")?.click();
      expect(onDiscardSessionPlacementStartup).toHaveBeenCalledOnce();
      expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
    },
  );

  it("keeps Retry and Discard reachable when exact history deduplicates the rejected initial turn", () => {
    const onRetrySessionPlacementStartup = vi.fn();
    const onDiscardSessionPlacementStartup = vi.fn();
    const container = renderChatView({
      canSend: false,
      messages: [
        {
          role: "user",
          content: "original prompt",
          __openclaw: { idempotencyKey: "initial:user" },
        },
      ],
      placementStartup: {
        sessionKey: "main",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        retryable: true,
        action: "retry",
        initialTurn: {
          id: "initial",
          sendRunId: "initial",
          text: "original prompt",
          createdAt: 1,
          sendAttempts: 1,
          sendState: "failed",
        },
      },
      onRetrySessionPlacementStartup,
      onDiscardSessionPlacementStartup,
    });
    expect(container.querySelectorAll(".chat-group.user")).toHaveLength(1);
    expect(container.querySelector(".chat-send-status__retry")).toBeNull();
    const action = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-error button"),
    ).find((button) => button.textContent?.trim() === "Retry");
    expect(action).toBeDefined();
    action?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
    expect(onDiscardSessionPlacementStartup).not.toHaveBeenCalled();
    const discard = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-error button"),
    ).find((button) => button.textContent?.trim() === "Discard");
    expect(discard).toBeDefined();
    discard?.click();
    expect(onDiscardSessionPlacementStartup).toHaveBeenCalledOnce();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
  });

  it("keeps the retained initial turn's Retry action usable while ordinary sending is held", () => {
    const onRetrySessionPlacementStartup = vi.fn();
    const onQueueRetry = vi.fn();
    const paneId = "startup-retry";
    saveChatSessionScrollPosition(paneId, "main", { scrollTop: 0, anchorToEnd: false });
    const container = renderChatView({
      transcript: createTestTranscript(paneId),
      canSend: false,
      messages: [
        { role: "user", content: "[System] Gateway restarted", timestamp: 3 },
        { role: "assistant", content: "Worker recovery is pending", timestamp: 4 },
      ],
      queue: [
        {
          id: "ordinary",
          text: "later draft",
          createdAt: 2,
          sendAttempts: 1,
          sendState: "failed",
        },
      ],
      placementStartup: {
        sessionKey: "agent:main:startup",
        targetKind: "profile",
        phase: "failed",
        startedAt: 1,
        retryable: true,
        action: "retry",
        error: "Retained initial turn",
        initialTurn: {
          id: "initial",
          sendRunId: "initial",
          text: "original prompt",
          createdAt: 1,
          sendAttempts: 1,
          sendState: "failed",
        },
      },
      onRetrySessionPlacementStartup,
      onQueueRetry,
    });
    expect(container.querySelector(".chat-thread")?.textContent).toContain("original prompt");
    expect(container.querySelector(".chat-thread")?.textContent).toContain("later draft");
    const transcript = container.querySelector(".chat-thread")?.textContent ?? "";
    expect(transcript.indexOf("original prompt")).toBeLessThan(
      transcript.indexOf("Gateway restarted"),
    );
    expect(transcript.indexOf("Worker recovery is pending")).toBeLessThan(
      transcript.indexOf("later draft"),
    );
    const buttons = container.querySelectorAll<HTMLButtonElement>(".chat-send-status__retry");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent?.trim()).toBe("Retry");
    buttons[0]?.click();
    expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
    expect(onQueueRetry).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-error")?.textContent).toContain("Retained initial turn");
  });
});
