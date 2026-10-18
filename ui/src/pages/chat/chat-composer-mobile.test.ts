/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createComposerControlsFixture,
  renderComposerFixture,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";

beforeEach(() => {
  const matchMedia = window.matchMedia.bind(window);
  const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const result = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(result, "matches", { value: true });
    }
    return result;
  });
  onTestFinished(() => media.mockRestore());
});
afterEach(() => resetComposerFixture());

it("keeps the draft and caret through mobile editing, own controls and outside focus", () => {
  const onComposerEditingChange = vi.fn();
  const { container, props } = renderComposerFixture({
    mobileComposer: true,
    draft: "A draft kept across focus changes",
    queue: [{ id: "queued", text: "Next message", createdAt: 1, sendState: "waiting-idle" }],
    composerControls: createComposerControlsFixture(),
    onComposerEditingChange,
  });
  document.body.append(container);
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const outside = container.querySelector<HTMLButtonElement>(".chat-queue__remove")!;
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(false);
  textarea.focus();
  textarea.value = "Updated draft kept across focus changes";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  textarea.setSelectionRange(2, 7);
  flush();
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(true);
  container.querySelector<HTMLButtonElement>(".chat-composer-model-control")!.focus();
  flush();
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(true);
  outside.focus();
  flush();
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(false);
  expect(textarea.value).toBe(props.draft);
  expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7]);
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(props.onSend).not.toHaveBeenCalled();
});

it("does not send when expansion moves an action beneath the first editor tap", () => {
  const { container, props } = renderComposerFixture({ mobileComposer: true, draft: "Keep this" });
  document.body.append(container);
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  textarea.focus();
  flush();
  container
    .querySelector<HTMLButtonElement>(".chat-send-btn--send")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe("Keep this");
});

it("accepts observed keyboard recovery even when the editor retains focus", () => {
  const onComposerEditingChange = vi.fn();
  const { container, props } = renderComposerFixture({
    mobileComposer: true,
    mobileKeyboardVisible: true,
    draft: "Retained draft",
    onComposerEditingChange,
  });
  document.body.append(container);
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.focus();
  flush();
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(true);
  renderComposerInto(container, { ...props, mobileKeyboardVisible: false });
  expect(onComposerEditingChange).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.value).toBe("Retained draft");
});

it("does not activate mobile editing in a desktop composer", () => {
  const onComposerEditingChange = vi.fn();
  const { container } = renderComposerFixture({ onComposerEditingChange });
  document.body.append(container);
  container.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  flush();
  expect(onComposerEditingChange).not.toHaveBeenCalledWith(true);
  expect(container.querySelector('[data-mobile-composer="true"]')).toBeNull();
});
