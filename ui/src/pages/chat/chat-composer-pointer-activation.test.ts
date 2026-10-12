/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { createComposerContainer, createComposerProps } from "./chat-composer.test-support.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.tsx";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

function renderComposer(overrides: Partial<ComposerProps> = {}): HTMLElement {
  const container = createComposerContainer();
  document.body.append(container);
  render(renderChatComposer(createComposerProps(overrides)), container);
  return container;
}

function button(container: Element, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) {
    throw new Error(`expected button ${label}`);
  }
  return result;
}

function textarea(container: Element): HTMLTextAreaElement {
  const result = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!result) {
    throw new Error("expected composer textarea");
  }
  return result;
}

function primaryPointerDown(): MouseEvent {
  return new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
}

afterEach(async () => {
  resetChatComposerState();
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("chat composer pointer activation", () => {
  it("does not steal focus when a menu replaces the clicked content", () => {
    const container = renderComposer({ draft: "Keep this draft" });
    const input = textarea(container);
    const focus = vi.spyOn(input, "focus");
    const menu = container.querySelector("wa-dropdown.agent-chat__capability-menu")!;
    const label = document.createElement("span");
    menu.append(label);
    label.addEventListener("click", () => label.remove());
    label.click();
    expect(label.isConnected).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(input.value).toBe("Keep this draft");
    container.querySelector<HTMLElement>(".agent-chat__input")!.click();
    expect(document.activeElement).toBe(input);
  });

  it("preserves only its own textarea focus during primary pointer actions", () => {
    const sendContainer = renderComposer({
      canAbort: true,
      draft: "Follow up",
      onAbort: vi.fn(),
      onSend: vi.fn(),
    });
    const sendInput = textarea(sendContainer);
    const send = button(sendContainer, t("chat.runControls.sendMessage"));

    sendInput.focus();
    // A native target listener runs before Solid's delegated bubble handler.
    send.addEventListener("pointerdown", () => sendInput.blur(), { once: true });
    const sendPointerDown = primaryPointerDown();
    send.dispatchEvent(sendPointerDown);
    expect(sendPointerDown.defaultPrevented).toBe(true);

    const stopContainer = renderComposer({ canAbort: true, onAbort: vi.fn() });
    const stopInput = textarea(stopContainer);
    const stop = button(stopContainer, t("chat.runControls.stopGenerating"));
    stopInput.focus();
    const stopPointerDown = primaryPointerDown();
    stop.dispatchEvent(stopPointerDown);
    expect(stopPointerDown.defaultPrevented).toBe(true);

    const unrelatedInput = document.createElement("input");
    document.body.append(unrelatedInput);
    unrelatedInput.focus();
    const unrelatedPointerDown = primaryPointerDown();
    send.dispatchEvent(unrelatedPointerDown);
    expect(unrelatedPointerDown.defaultPrevented).toBe(false);
  });

  it("retains focus while Send clears the draft and Stop preserves it", () => {
    let sendDraft = "Send this";
    const onSend = vi.fn(() => {
      sendDraft = "";
    });
    const onSendTypingChange = vi.fn();
    const sendContainer = renderComposer({
      draft: sendDraft,
      getDraft: () => sendDraft,
      onDraftChange: (value) => {
        sendDraft = value;
      },
      onSend,
      onTypingChange: onSendTypingChange,
    });
    const sendTextarea = textarea(sendContainer);
    const send = button(sendContainer, t("chat.runControls.sendMessage"));
    sendTextarea.focus();
    send.dispatchEvent(primaryPointerDown());
    send.click();

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSendTypingChange).toHaveBeenLastCalledWith(false);
    expect(sendTextarea.value).toBe("");
    expect(document.activeElement).toBe(sendTextarea);

    const onAbort = vi.fn();
    const onStopTypingChange = vi.fn();
    const stopContainer = renderComposer({
      canAbort: true,
      onAbort,
      onTypingChange: onStopTypingChange,
    });
    const stopTextarea = textarea(stopContainer);
    const stop = button(stopContainer, t("chat.runControls.stopGenerating"));
    stopTextarea.focus();
    stop.dispatchEvent(primaryPointerDown());
    stop.click();

    expect(onAbort).toHaveBeenCalledOnce();
    expect(stopTextarea.value).toBe("");
    expect(document.activeElement).toBe(stopTextarea);
    expect(onStopTypingChange).not.toHaveBeenCalled();
  });

  it("does not leave composition state stuck after pointer Send", () => {
    let draft = "構成中";
    const onSend = vi.fn(() => {
      draft = "";
    });
    const container = renderComposer({
      draft,
      getDraft: () => draft,
      onDraftChange: (value) => {
        draft = value;
      },
      onSend,
    });
    const input = textarea(container);
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const send = button(container, t("chat.runControls.sendMessage"));
    send.dispatchEvent(primaryPointerDown());
    send.click();
    expect(onSend).toHaveBeenCalledOnce();

    input.value = "next";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(onSend).toHaveBeenCalledTimes(2);
  });
});
