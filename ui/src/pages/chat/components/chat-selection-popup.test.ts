import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  handleChatSelectionPointerUp,
  removeChatSelectionPopup,
  showChatAnnotationEditor,
} from "./chat-selection-popup.ts";

// jsdom Ranges have no layout (and no getBoundingClientRect at all); stub the
// rect the popup positions against and remove the stub afterwards.
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({ top: 100, left: 100, bottom: 120, right: 200, width: 100, height: 20 }) as DOMRect,
  });
});
afterAll(() => {
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

function buildThreadWithBubble(text: string) {
  const thread = document.createElement("div");
  thread.className = "chat-thread";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.dataset.messageId = "assistant-1";
  bubble.dataset.entryId = "entry-1";
  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text;
  bubble.appendChild(body);
  thread.appendChild(bubble);
  document.body.appendChild(thread);
  return { thread, textNode: body.firstChild as Text };
}

function selectRange(node: Text, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function pointerUp(thread: HTMLElement) {
  handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
    onAddToChat: onAddToChatSpy,
    onAskSideChat: onAskSideChatSpy,
  });
  vi.runAllTimers();
}

const onAskSideChatSpy = vi.fn();
const onAddToChatSpy = vi.fn();

describe("chat selection popup", () => {
  afterEach(() => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    onAskSideChatSpy.mockReset();
    onAddToChatSpy.mockReset();
    vi.useRealTimers();
  });

  it.each([0, 1])("routes selection action %i to its own composer", (actionIndex) => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("Let's Encrypt cert is valid");
    selectRange(textNode, 0, 18);
    pointerUp(thread);

    const popup = document.body.querySelector(".chat-selection-popup");
    expect(popup).not.toBeNull();
    expect(popup?.getAttribute("aria-label")).toBe("Selection actions");
    const buttons = [...(popup?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Add to chat",
      "Ask in side chat",
    ]);
    expect(buttons[0]?.querySelector("svg")).toBeNull();

    buttons[actionIndex]?.click();
    const [called, untouched] =
      actionIndex === 0 ? [onAddToChatSpy, onAskSideChatSpy] : [onAskSideChatSpy, onAddToChatSpy];
    if (actionIndex === 0) {
      expect(called).toHaveBeenCalledWith(
        {
          text: "Let's Encrypt cert",
          start: 0,
          end: 18,
          messageId: "assistant-1",
          entryId: "entry-1",
        },
        expect.objectContaining({ top: 100, left: 100 }),
      );
    } else {
      expect(called).toHaveBeenCalledWith("Let's Encrypt cert");
    }
    expect(untouched).not.toHaveBeenCalled();
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });

  it("retains exact whitespace and the source offset of a repeated Unicode selection", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("🦞 first\n  second  ");
    selectRange(textNode, 9, 19);
    pointerUp(thread);
    document.querySelector<HTMLButtonElement>(".chat-selection-popup button")!.click();
    expect(onAddToChatSpy).toHaveBeenCalledWith(
      {
        text: "  second  ",
        start: 9,
        end: 19,
        messageId: "assistant-1",
        entryId: "entry-1",
      },
      expect.anything(),
    );
  });

  it("ignores selections outside chat bubbles and collapsed selections", () => {
    vi.useFakeTimers();
    const { thread } = buildThreadWithBubble("bubble text");
    const outside = document.createElement("p");
    outside.textContent = "outside text";
    document.body.appendChild(outside);
    selectRange(outside.firstChild as Text, 0, 7);
    pointerUp(thread);
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();

    window.getSelection()?.removeAllRanges();
    pointerUp(thread);
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });

  it("does not restore the popup after its owner tears down", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("tear down before the selection settles");
    selectRange(textNode, 0, 9);
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      onAddToChat: onAddToChatSpy,
      onAskSideChat: onAskSideChatSpy,
    });

    removeChatSelectionPopup();
    vi.runAllTimers();

    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });

  it("keeps only the latest pending selection popup", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("replacement selection");
    const firstAskSideChat = vi.fn();
    const secondAskSideChat = vi.fn();
    selectRange(textNode, 0, 11);
    const pendingTimerCount = vi.getTimerCount();
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      onAskSideChat: firstAskSideChat,
    });
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      onAskSideChat: secondAskSideChat,
    });

    expect(vi.getTimerCount()).toBe(pendingTimerCount + 1);
    vi.advanceTimersToNextTimer();
    (document.body.querySelector(".chat-selection-popup button") as HTMLButtonElement).click();

    expect(firstAskSideChat).not.toHaveBeenCalled();
    expect(secondAskSideChat).toHaveBeenCalledWith("replacement");
  });

  it("dismisses when the selection collapses", () => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("dismiss me later");
    selectRange(textNode, 0, 7);
    pointerUp(thread);
    expect(document.body.querySelector(".chat-selection-popup")).not.toBeNull();

    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
  });
});

describe("chat annotation editor", () => {
  afterEach(() => {
    removeChatSelectionPopup();
    document.body.innerHTML = "";
  });

  function editor(options: Partial<Parameters<typeof showChatAnnotationEditor>[0]> = {}) {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    showChatAnnotationEditor({
      anchorRect: new DOMRect(100, 100, 100, 20),
      comment: "",
      onSave,
      onCancel,
      ...options,
    });
    const input = document.querySelector("textarea")!;
    return { input, onSave, onCancel };
  }

  it("confirms an empty optional comment only on activation", () => {
    const { input, onSave } = editor();
    expect(document.activeElement).toBe(input);
    expect(onSave).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSave).toHaveBeenCalledWith("");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("keeps edits local until Save and cancels without changing a saved comment", () => {
    const { input, onSave, onCancel } = editor({ comment: "Saved comment", expanded: true });
    input.value = "Unsaved edit";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("preserves multiline and Unicode comments and ignores IME Enter", () => {
    const { input, onSave } = editor();
    input.value = "  Why this? 🦞\nKeep the next line.  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(onSave).not.toHaveBeenCalled();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(onSave).toHaveBeenCalledWith("  Why this? 🦞\nKeep the next line.  ");
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "preserves unsaved comments when Escape dismisses IME candidates: %j",
    (composition) => {
      const { input, onSave, onCancel } = editor({ expanded: true });
      input.value = "変換中のコメント";
      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...composition,
      });
      input.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
      expect(document.querySelector("[role=dialog]")).not.toBeNull();
      expect(input.value).toBe("変換中のコメント");
      expect(onSave).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector("[role=dialog]")).toBeNull();
      expect(onCancel).toHaveBeenCalledOnce();
    },
  );

  it("keeps rejected saves editable and retires a stale owner", () => {
    const controller = new AbortController();
    const onSave = vi.fn(() => false);
    const { input } = editor({ readSignal: controller.signal, onSave });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    controller.abort();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("deletes only through the explicit Delete control", () => {
    const onDelete = vi.fn();
    const { onSave } = editor({ expanded: true, onDelete });
    document.querySelector<HTMLButtonElement>(".chat-annotation-editor__delete")!.click();
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
