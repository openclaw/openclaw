/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { getComposerTextarea, renderChatView } from "./chat-view.test-helpers.ts";
import * as chatMessage from "./components/chat-message.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.spyOn(chatMessage, "renderStreamGroup");
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

  it("retains Check status when the same contention diagnostic is in history", () => {
    const onRefresh = vi.fn();
    const summary = "Temporarily busy. Check status before trying again.";
    const container = renderChatView({
      messages: [
        {
          role: "custom",
          customType: "run-failed-before-reply",
          content: summary,
          details: { errorKind: "state_contention" },
          __openclaw: { id: "busy-notice", seq: 1, runId: "busy-run" },
        },
      ],
      runError: { kind: "state_contention", runId: "busy-run", summary },
      onRefresh,
    });
    expect(container.querySelectorAll(".chat-error")).toHaveLength(1);
    const notice = container.querySelector(".chat-error");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.classList.contains("chat-composer-neighbor-card--warn")).toBe(true);
    expect(container.querySelector(".chat-bubble .chat-error")).toBeNull();
    expect(container.querySelector(".chat-bubble")?.textContent).toContain(summary);
    const check = notice?.querySelector<HTMLButtonElement>(".chat-error__refresh");
    expect(check?.textContent?.trim()).toBe("Check status");
    check?.click();
    expect(onRefresh).toHaveBeenCalledOnce();
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
    expect(vi.mocked(chatMessage.renderStreamGroup).mock.calls.at(-1)?.[1]?.startupLabel).toBe(
      "Temporarily busy—retrying…",
    );
    expect(container.querySelector(".chat-error")).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>(".chat-send-btn--stop");
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onAbort).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });
});
