// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderChatView, requireElement } from "./chat-view.test-helpers.ts";

describe("chat voice working status", () => {
  it("shows delegated work beside the live microphone without replacing listening", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkWorking: true,
      realtimeTalkStatus: "listening",
    });

    const status = requireElement(
      container,
      '.agent-chat__voice-work-status[role="status"]',
      "voice working status",
    );
    expect(status.textContent).toContain("Working...");
    expect(
      container.querySelector('.agent-chat__voice-activity[data-status="listening"]'),
    ).not.toBeNull();
  });

  it("shows the badge while a chat reply runs during a voice call", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkWorking: false,
      realtimeTalkStatus: "listening",
      canAbort: true,
      onAbort: () => {},
    });

    expect(container.querySelector(".agent-chat__voice-work-status")?.textContent).toContain(
      "Working...",
    );
  });

  it("hides the badge when voice is idle between replies", () => {
    const container = renderChatView({
      realtimeTalkActive: true,
      realtimeTalkWorking: false,
      realtimeTalkStatus: "listening",
      canAbort: false,
    });

    expect(container.querySelector(".agent-chat__voice-work-status")).toBeNull();
  });
});
