/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { getComposerTextarea, renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

const workingStatus = (container: HTMLElement) =>
  container.querySelector(".chat-working-indicator__status")?.textContent;

it("keeps a contention check separate from sending and the composer draft", () => {
  const onRefresh = vi.fn();
  const onSend = vi.fn();
  const onDraftChange = vi.fn();
  const container = renderChatView({
    draft: "My unsent draft",
    runError: { kind: "state_contention", summary: "Temporarily busy." },
    onRefresh,
    onSend,
    onDraftChange,
  });
  const input = getComposerTextarea(container);
  expect(input.value).toBe("My unsent draft");
  container.querySelector<HTMLButtonElement>(".chat-error__refresh")?.click();
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  expect(onDraftChange).not.toHaveBeenCalled();
  expect(input.value).toBe("My unsent draft");
});

it.each([
  ["waiting_for_state", "Temporarily busy—retrying…"],
  ["preparing_context", "Preparing this turn…"],
  ["answer", null],
  ["finishing", null],
] as const)("keeps Stop available during %s", (phase, status) => {
  const onAbort = vi.fn();
  const onSend = vi.fn();
  const container = renderChatView({
    canAbort: true,
    runActive: true,
    runId: "run-1",
    stream: status ? "" : "The answer is ready.",
    startupStatus: { state: "status", runId: "run-1", phase },
    onAbort,
    onSend,
  });
  if (status) {
    expect(workingStatus(container)).toContain(status);
    expect(container.querySelector(".chat-error")).toBeNull();
  } else {
    expect(container.textContent).toContain("The answer is ready.");
    expect(container.querySelector(".chat-working-indicator")).toBeNull();
    expect(
      container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
    ).toBe("");
  }
  const stop = container.querySelector<HTMLButtonElement>(".chat-send-btn--stop");
  expect(stop).not.toBeNull();
  stop?.click();
  expect(onAbort).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
});

it("waits for startup progress rather than claiming preparation before the first status", () => {
  const container = renderChatView({ runActive: true, stream: "" });
  expect(workingStatus(container)).toContain("Waiting for turn to start…");
});

it.each(["submitting", "sending", "waiting-model"] as const)(
  "awaits %s without Stop",
  (sendState) => {
    const container = renderChatView({
      runActive: false,
      canAbort: false,
      stream: null,
      queue: [
        { id: "pending-send", sessionKey: "main", text: "Continue", createdAt: 1, sendState },
      ],
    });
    expect(workingStatus(container)).toContain("Waiting for turn to start…");
    expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
  },
);
