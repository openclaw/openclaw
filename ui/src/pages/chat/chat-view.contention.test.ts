/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { getComposerTextarea, renderChatView } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

describe("chat view state contention", () => {
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

  it("keeps Stop available during a quiet state contention wait", () => {
    const onAbort = vi.fn();
    const onSend = vi.fn();
    const container = renderChatView({
      canAbort: true,
      runActive: true,
      runId: "run-1",
      stream: "",
      startupStatus: { state: "status", runId: "run-1", phase: "waiting_for_state" },
      onAbort,
      onSend,
    });
    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      "Temporarily busy—retrying…",
    );
    expect(container.querySelector(".chat-error")).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>(".chat-send-btn--stop");
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("waits for startup progress rather than claiming preparation before the first status", () => {
    const container = renderChatView({ runActive: true, stream: "" });
    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      "Waiting for turn to start…",
    );
  });

  it.each(["submitting", "sending", "waiting-model"] as const)(
    "does not claim preparation or offer Stop for a local %s send without run custody",
    (sendState) => {
      const container = renderChatView({
        runActive: false,
        canAbort: false,
        stream: null,
        queue: [
          { id: "pending-send", sessionKey: "main", text: "Continue", createdAt: 1, sendState },
        ],
      });
      expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
        "Waiting for turn to start…",
      );
      expect(container.querySelector(".chat-send-btn--stop")).toBeNull();
    },
  );

  it("retains preparation and Stop once the Gateway reports context preparation", () => {
    const container = renderChatView({
      runActive: true,
      canAbort: true,
      runId: "run-1",
      stream: "",
      startupStatus: { state: "status", runId: "run-1", phase: "preparing_context" },
    });
    expect(container.querySelector(".chat-working-indicator__status")?.textContent).toContain(
      "Preparing this turn…",
    );
    expect(container.querySelector(".chat-send-btn--stop")).not.toBeNull();
  });

  it.each(["answer", "finishing"] as const)(
    "hides %s activity without releasing the active run or Stop",
    (phase) => {
      const onAbort = vi.fn();
      const container = renderChatView({
        canAbort: true,
        runActive: true,
        runId: "run-1",
        stream: "The answer is ready.",
        startupStatus: { state: "status", runId: "run-1", phase },
        onAbort,
      });
      expect(container.textContent).toContain("The answer is ready.");
      expect(container.querySelector(".chat-working-indicator")).toBeNull();
      expect(
        container.querySelector(".agent-chat__run-status-announcement")?.textContent?.trim(),
      ).toBe("");
      const stop = container.querySelector<HTMLButtonElement>(".chat-send-btn--stop");
      expect(stop).not.toBeNull();
      stop?.click();
      expect(onAbort).toHaveBeenCalledOnce();
    },
  );
});
