/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

type Startup = NonNullable<NonNullable<Parameters<typeof renderChatView>[0]>["placementStartup"]>;
function startup(phase: Startup["phase"], overrides: Partial<Startup> = {}): Startup {
  return {
    sessionKey: "main",
    targetKind: "profile",
    phase,
    startedAt: 1,
    ...(phase === "failed" ? { retryable: true, action: "retry" } : {}),
    initialTurn: {
      id: "initial",
      sendRunId: "initial",
      text: "original prompt",
      createdAt: 1,
      sendAttempts: 1,
      sendState:
        phase === "failed" ? "failed" : phase === "sending" ? "sending" : "waiting-reconnect",
    },
    ...overrides,
  };
}
const recordedTurn = (content: string) => ({
  role: "user",
  content,
  __openclaw: { idempotencyKey: "initial:user" },
});

it.each([
  { connected: false, recorded: false },
  { connected: false, recorded: true },
  { connected: true, recorded: true },
])(
  "shows initial-turn recovery controls only while reconnecting (%o)",
  async ({ connected, recorded }) => {
    const onRetrySessionPlacementStartup = vi.fn();
    const onDiscardSessionPlacementStartup = vi.fn();
    const container = renderChatView({
      connected,
      canSend: false,
      messages: recorded ? [recordedTurn("original prompt")] : [],
      placementStartup: startup(connected ? "sending" : "reconnecting"),
      onRetrySessionPlacementStartup,
      onDiscardSessionPlacementStartup,
    });
    await flushDeferredRowPrune();
    expect(container.querySelectorAll(".chat-group.user")).toHaveLength(1);
    const status = container.querySelector(".chat-send-status");
    if (connected) {
      expect(status).toBeNull();
      return;
    }
    expect(status?.textContent).toContain("Waiting for reconnect");
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
    messages: [recordedTurn("original prompt")],
    placementStartup: startup("failed"),
    onRetrySessionPlacementStartup,
    onDiscardSessionPlacementStartup,
  });
  expect(container.querySelectorAll(".chat-group.user")).toHaveLength(1);
  expect(container.querySelector(".chat-send-status__retry")).toBeNull();
  const errorAction = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>(".chat-error button")).find(
      (button) => button.textContent?.trim() === label,
    );
  const action = errorAction("Retry");
  expect(action).toBeDefined();
  action?.click();
  expect(onRetrySessionPlacementStartup).toHaveBeenCalledOnce();
  expect(onDiscardSessionPlacementStartup).not.toHaveBeenCalled();
  const discard = errorAction("Discard");
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
    placementStartup: startup("failed", {
      sessionKey: "agent:main:startup",
      error: "Retained initial turn",
    }),
    onRetrySessionPlacementStartup,
    onQueueRetry,
  });
  const transcript = container.querySelector(".chat-thread")?.textContent ?? "";
  expect(transcript).toContain("original prompt");
  expect(transcript).toContain("later draft");
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
