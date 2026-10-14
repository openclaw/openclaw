/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerFixture,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.tsx";

afterEach(() => resetComposerFixture());

function getComposerTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) {
    throw new Error("Expected composer textarea");
  }
  return textarea;
}

describe("chat composer IME composition", () => {
  it.each(["keyup", "blur", "keydown"])(
    "allows an immediate deliberate Enter after %s without affecting another composer",
    (type) => {
      const first = renderComposerFixture({ draft: "日本語" });
      const second = renderComposerFixture({ draft: "another draft" });
      const textarea = getComposerTextarea(first.container);
      const end = new CompositionEvent("compositionend", { bubbles: true });
      textarea.dispatchEvent(end);
      const enter = () => {
        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
        Object.defineProperty(event, "timeStamp", { value: end.timeStamp + 1 });
        return event;
      };
      getComposerTextarea(second.container).dispatchEvent(enter());
      expect(second.props.onSend).toHaveBeenCalledOnce();
      expect(first.props.onSend).not.toHaveBeenCalled();

      textarea.dispatchEvent(
        type === "blur"
          ? new FocusEvent("blur")
          : new KeyboardEvent(type, { key: type === "keydown" ? "Meta" : "Enter", bubbles: true }),
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
      const onSend = vi.fn();
      const onDraftChange = vi.fn();
      const props = createComposerProps({ onSend, onDraftChange, sendShortcut });
      const container = createComposerContainer();
      render(renderChatComposer(props), container);
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
      render(renderChatComposer({ ...props, draft: "日本語" }), container);

      for (const offset of [confirmOffset, 99, 100]) {
        const enter = new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        });
        Object.defineProperty(enter, "timeStamp", { value: end.timeStamp + offset });
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
    // Browsers can drop compositionend (detach/blur mid-IME). The composing
    // flag persists across renders, so without the blur reset Enter, history
    // keys, and command menus stay dead until the Send button is clicked.
    const onHistoryKeydown = vi.fn(() => ({
      handled: true,
      preventDefault: true,
      restoreCaret: null,
    }));
    const onSend = vi.fn();
    const container = renderComposerFixture({ onHistoryKeydown, onSend, draft: "hello" }).container;
    const textarea = getComposerTextarea(container);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "dangqian";
    for (const key of ["Enter", "ArrowUp"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onSend).not.toHaveBeenCalled();
    expect(onHistoryKeydown).not.toHaveBeenCalled();
    expect(textarea.value).toBe("dangqian");

    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    const enterEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(enterEvent);

    expect(enterEvent.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("invalidates after handled input history navigation", () => {
    const onRequestUpdate = vi.fn();
    const onHistoryKeydown = vi.fn(() => ({
      handled: true,
      preventDefault: true,
      restoreCaret: "up" as const,
    }));
    const container = renderComposerFixture({ onHistoryKeydown, onRequestUpdate }).container;
    const textarea = getComposerTextarea(container);
    const arrowEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(arrowEvent);
    expect(arrowEvent.defaultPrevented).toBe(true);
    expect(onHistoryKeydown).toHaveBeenCalledOnce();
    expect(onRequestUpdate).toHaveBeenCalledOnce();
  });
});
