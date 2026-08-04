/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { submitChatWidgetPrompt } from "./chat-widget-prompt.ts";

describe("submitChatWidgetPrompt", () => {
  it("submits a re-entered widget action once with a stable id", () => {
    const handleSendChat = vi.fn((_message: string, _options: { submissionId: string }) =>
      Promise.resolve(),
    );
    const host = { handleSendChat };
    const action = new CustomEvent("openclaw:widget-prompt", {
      detail: { text: "  inspect this widget  " },
    });

    submitChatWidgetPrompt(host, action);
    submitChatWidgetPrompt(host, action);

    expect(handleSendChat).toHaveBeenCalledOnce();
    expect(handleSendChat).toHaveBeenCalledWith("inspect this widget", {
      submissionId: expect.any(String),
    });
  });

  it("keeps independent widget actions distinct", () => {
    const handleSendChat = vi.fn((_message: string, _options: { submissionId: string }) =>
      Promise.resolve(),
    );
    const host = { handleSendChat };

    submitChatWidgetPrompt(
      host,
      new CustomEvent("openclaw:widget-prompt", { detail: { text: "same prompt" } }),
    );
    submitChatWidgetPrompt(
      host,
      new CustomEvent("openclaw:widget-prompt", { detail: { text: "same prompt" } }),
    );

    expect(handleSendChat).toHaveBeenCalledTimes(2);
    expect(handleSendChat.mock.calls[0]?.[1]?.submissionId).not.toBe(
      handleSendChat.mock.calls[1]?.[1]?.submissionId,
    );
  });
});
