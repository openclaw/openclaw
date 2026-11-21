/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  renderComposerFixture,
  resetComposerFixture,
  renderComposerInto,
} from "./chat-composer.test-support.ts";

afterEach(() => resetComposerFixture());

const getComposerTextarea = (container: HTMLElement) => container.querySelector("textarea")!;

function keyEvent(type = "keydown", options: KeyboardEventInit = {}) {
  return new KeyboardEvent(type, { key: "Enter", bubbles: true, cancelable: true, ...options });
}

function timedEnter(end: Event, offset: number, options: KeyboardEventInit = {}): KeyboardEvent {
  return Object.defineProperty(keyEvent("keydown", options), "timeStamp", {
    value: end.timeStamp + offset,
  });
}

it.each(["keyup", "blur", "keydown"])(
  "allows an immediate deliberate Enter after %s without affecting another composer",
  (type) => {
    const first = renderComposerFixture({ draft: "日本語" });
    const second = renderComposerFixture({ draft: "another draft" });
    const textarea = getComposerTextarea(first.container);
    const end = new CompositionEvent("compositionend", { bubbles: true });
    textarea.dispatchEvent(end);
    const enter = () => timedEnter(end, 1, { cancelable: false });
    getComposerTextarea(second.container).dispatchEvent(enter());
    expect(second.props.onSend).toHaveBeenCalledOnce();
    expect(first.props.onSend).not.toHaveBeenCalled();

    textarea.dispatchEvent(
      type === "blur"
        ? new FocusEvent("blur")
        : keyEvent(type, { key: type === "keydown" ? "Meta" : "Enter", cancelable: false }),
    );
    textarea.dispatchEvent(enter());
    expect(first.props.onSend).toHaveBeenCalledOnce();
  },
);

it.each([
  { sendShortcut: "enter", modifiers: {}, confirmOffset: -1 },
  { sendShortcut: "enter", modifiers: {}, confirmOffset: 1 },
  { sendShortcut: "modifier-enter", modifiers: { ctrlKey: true }, confirmOffset: 1 },
  { sendShortcut: "modifier-enter", modifiers: { metaKey: true }, confirmOffset: 1 },
] as const)(
  "keeps a Safari composition-confirm Enter in the draft: %j",
  ({ sendShortcut, modifiers, confirmOffset }) => {
    const { container, props } = renderComposerFixture({ sendShortcut });
    const { onSend, onDraftChange } = props;
    const textarea = getComposerTextarea(container);
    textarea.style.height = "42px";
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    for (const value of ["shi", "shichang"]) {
      textarea.value = value;
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    }
    expect(textarea.style.height).toBe("42px");
    textarea.value = "日本語";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    const end = new CompositionEvent("compositionend", { bubbles: true, data: "日本語" });
    textarea.dispatchEvent(end);
    expect(textarea.style.height).not.toBe("42px");
    renderComposerInto(container, { ...props, draft: "日本語" });

    for (const offset of [confirmOffset, 99, 100]) {
      const enter = timedEnter(end, offset, { keyCode: 13, ...modifiers });
      textarea.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(offset === 100);
      expect(onSend).toHaveBeenCalledTimes(offset === 100 ? 1 : 0);
      if (offset !== 100) {
        expect(textarea.value).toBe("日本語");
      }
    }
    expect(onDraftChange).toHaveBeenCalledWith("日本語", undefined);
  },
);

it("leaves active IME keys to the browser and recovers Enter-send after blur", () => {
  // A dropped compositionend must not leave Enter and history keys stuck after blur.
  const onHistoryKeydown = vi.fn(() => ({
    handled: true,
    preventDefault: true,
    restoreCaret: null,
  }));
  const { container, props } = renderComposerFixture({ onHistoryKeydown, draft: "hello" });
  const textarea = getComposerTextarea(container);

  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  textarea.value = "dangqian";
  for (const key of ["Enter", "ArrowUp"]) {
    const event = keyEvent("keydown", { key });
    textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(props.onSend).not.toHaveBeenCalled();
  expect(onHistoryKeydown).not.toHaveBeenCalled();
  expect(textarea.value).toBe("dangqian");

  textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

  const enterEvent = keyEvent();
  textarea.dispatchEvent(enterEvent);

  expect(enterEvent.defaultPrevented).toBe(true);
  expect(props.onSend).toHaveBeenCalledOnce();
});
