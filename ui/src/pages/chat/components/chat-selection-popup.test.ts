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
    paneId: "pane-a",
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

  it("routes Add to chat to its own composer", () => {
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

    buttons[0]?.click();
    expect(onAddToChatSpy).toHaveBeenCalledWith(
      {
        text: "Let's Encrypt cert",
        start: 0,
        end: 18,
        messageId: "assistant-1",
        entryId: "entry-1",
      },
      expect.objectContaining({ top: 100, left: 100 }),
    );
    expect(onAskSideChatSpy).not.toHaveBeenCalled();
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(document.body.querySelector(".chat-selection-popup")).toBeNull();
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
      paneId: "pane-a",
      onAddToChat: onAddToChatSpy,
      onAskSideChat: onAskSideChatSpy,
    });

    removeChatSelectionPopup("pane-a");
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
      paneId: "pane-a",
      onAskSideChat: firstAskSideChat,
    });
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      paneId: "pane-a",
      onAskSideChat: secondAskSideChat,
    });

    expect(vi.getTimerCount()).toBe(pendingTimerCount + 1);
    vi.advanceTimersToNextTimer();
    (document.body.querySelector(".chat-selection-popup button") as HTMLButtonElement).click();

    expect(firstAskSideChat).not.toHaveBeenCalled();
    expect(secondAskSideChat).toHaveBeenCalledWith(
      expect.objectContaining({ text: "replacement" }),
      expect.anything(),
    );
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

  it.each(["pending", "mounted"])("keeps a %s selection when another pane retires", (phase) => {
    vi.useFakeTimers();
    const { thread, textNode } = buildThreadWithBubble("Keep this selection");
    selectRange(textNode, 0, 4);
    handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
      paneId: "pane-a",
      onAskSideChat: onAskSideChatSpy,
    });
    if (phase === "mounted") {
      vi.runAllTimers();
    }
    removeChatSelectionPopup("pane-b");
    vi.runAllTimers();
    expect(document.querySelector(".chat-selection-popup")).not.toBeNull();
    removeChatSelectionPopup("pane-a");
    expect(document.querySelector(".chat-selection-popup")).toBeNull();
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
      paneId: "pane-a",
      anchorRect: new DOMRect(100, 100, 100, 20),
      comment: "",
      onSave,
      onCancel,
      ...options,
    });
    const input = document.querySelector("textarea")!;
    return { input, onSave, onCancel };
  }

  it.each([
    { modifiers: {}, release: "keyup" },
    { modifiers: { ctrlKey: true }, release: "blur" },
    { modifiers: { metaKey: true }, release: "timeout" },
  ])(
    "keeps the comment editor open on Safari composition-confirm Enter: %j",
    ({ modifiers, release }) => {
      const { input, onSave } = editor({ comment: "日本語" });
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const end = new CompositionEvent("compositionend", { bubbles: true, data: "日本語" });
      input.dispatchEvent(end);
      for (const offset of [1, 100]) {
        const enter = new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        });
        Object.defineProperty(enter, "timeStamp", {
          value: end.timeStamp + (release === "timeout" ? offset : 1),
        });
        if (offset === 100 && release !== "timeout") {
          input.dispatchEvent(
            release === "blur"
              ? new FocusEvent("blur")
              : new KeyboardEvent("keyup", { key: "Enter" }),
          );
        }
        input.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(offset === 100);
        expect(onSave).toHaveBeenCalledTimes(offset === 100 ? 1 : 0);
        expect(document.querySelector("[role=dialog]") !== null).toBe(offset !== 100);
      }
      expect(onSave).toHaveBeenCalledWith("日本語");
    },
  );

  it("preserves unsaved comments when legacy Escape dismisses IME candidates", () => {
    const { input, onSave, onCancel } = editor({ expanded: true });
    input.value = "変換中のコメント";
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      keyCode: 229,
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
  });

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
