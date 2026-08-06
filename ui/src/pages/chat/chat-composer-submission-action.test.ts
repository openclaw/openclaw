/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

function renderComposer(onSend: ComposerProps["onSend"]) {
  const container = document.createElement("div");
  render(
    renderChatComposer({
      paneId: crypto.randomUUID(),
      sessionKey: "main",
      currentAgentId: "main",
      connected: true,
      canSend: true,
      disabledReason: null,
      sending: false,
      messages: [],
      stream: null,
      queue: [],
      draft: "same prompt",
      sessions: null,
      assistantName: "OpenClaw",
      onDraftChange: vi.fn(),
      onSend,
      onQueueRemove: vi.fn(),
      onNewSession: vi.fn(),
    }),
    container,
  );
  return container;
}

afterEach(() => {
  resetChatComposerState();
  document.body.replaceChildren();
});

describe("chat composer submission actions", () => {
  it("creates a distinct submission id for each explicit send action", () => {
    const onSend = vi.fn();
    const container = renderComposer(onSend);
    const send = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("chat.runControls.sendMessage")}"]`,
    );

    send?.click();
    send?.click();

    expect(onSend).toHaveBeenCalledTimes(2);
    const submissionIds = onSend.mock.calls.map(([submissionId]) => submissionId);
    expect(submissionIds).toEqual([expect.any(String), expect.any(String)]);
    expect(submissionIds[0]).not.toBe(submissionIds[1]);
  });

  it("submits once when one send action re-enters its handler", () => {
    const onSend = vi.fn();
    const container = renderComposer(onSend);
    const action = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    const input = container.querySelector<HTMLTextAreaElement>("textarea");

    input?.dispatchEvent(action);
    input?.dispatchEvent(action);

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(expect.any(String));
  });
});
