import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  const selected = window.getSelection();
  selected?.removeAllRanges();
  selected?.addRange(range);
}

function pointerUp(
  thread: HTMLElement,
  options: Partial<Parameters<typeof handleChatSelectionPointerUp>[1]> = {
    onAddToChat: onAddToChatSpy,
    onAskSideChat: onAskSideChatSpy,
  },
  settle = true,
) {
  handleChatSelectionPointerUp({ currentTarget: thread } as unknown as PointerEvent, {
    paneId: "pane-a",
    ...options,
  });
  if (settle) {
    vi.runAllTimers();
  }
}

function selection(text: string, end: number) {
  const { thread, textNode } = buildThreadWithBubble(text);
  selectRange(textNode, 0, end);
  return thread;
}
const popup = () => document.querySelector(".chat-selection-popup");
const dialog = () => document.querySelector("[role=dialog]");
function scrollTranscript() {
  const transcript = document.body.appendChild(document.createElement("div"));
  transcript.className = "chat-transcript";
  transcript.dispatchEvent(new Event("scroll", { bubbles: false }));
}
function key(input: EventTarget, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, ...options });
  input.dispatchEvent(event);
  return event;
}

const onAskSideChatSpy = vi.fn();
const onAddToChatSpy = vi.fn();

describe("chat selection popup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
    onAskSideChatSpy.mockReset();
    onAddToChatSpy.mockReset();
    vi.useRealTimers();
  });

  it("routes Add to chat to its own composer", () => {
    const thread = selection("Let's Encrypt cert is valid", 18);
    pointerUp(thread);
    const toolbar = popup();
    expect(toolbar).not.toBeNull();
    expect(toolbar?.getAttribute("aria-label")).toBe("Selection actions");
    const buttons = [...(toolbar?.querySelectorAll("button") ?? [])];
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
    expect(popup()).toBeNull();
  });

  it("ignores selections outside chat bubbles and collapsed selections", () => {
    const { thread } = buildThreadWithBubble("bubble text");
    const outside = document.createElement("p");
    outside.textContent = "outside text";
    document.body.appendChild(outside);
    selectRange(outside.firstChild as Text, 0, 7);
    pointerUp(thread);
    expect(popup()).toBeNull();
    window.getSelection()?.removeAllRanges();
    pointerUp(thread);
    expect(popup()).toBeNull();
  });

  it("does not restore the popup after its owner tears down", () => {
    const thread = selection("tear down before the selection settles", 9);
    pointerUp(thread, undefined, false);
    removeChatSelectionPopup("pane-a");
    vi.runAllTimers();
    expect(popup()).toBeNull();
  });

  it("keeps only the latest pending selection popup", () => {
    const { thread, textNode } = buildThreadWithBubble("replacement selection");
    const firstAskSideChat = vi.fn();
    const secondAskSideChat = vi.fn();
    selectRange(textNode, 0, 11);
    const pendingTimerCount = vi.getTimerCount();
    pointerUp(thread, { onAskSideChat: firstAskSideChat }, false);
    pointerUp(thread, { onAskSideChat: secondAskSideChat }, false);
    expect(vi.getTimerCount()).toBe(pendingTimerCount + 1);
    vi.advanceTimersToNextTimer();
    (document.body.querySelector(".chat-selection-popup button") as HTMLButtonElement).click();
    expect(firstAskSideChat).not.toHaveBeenCalled();
    expect(secondAskSideChat).toHaveBeenCalledWith(
      expect.objectContaining({ text: "replacement" }),
      expect.anything(),
    );
  });

  it("dismisses the selection toolbar when the transcript scrolls", () => {
    const thread = selection("scroll away from me", 7);
    pointerUp(thread);
    expect(popup()).not.toBeNull();
    scrollTranscript();
    expect(popup()).toBeNull();
  });

  it("dismisses when the selection collapses", () => {
    const thread = selection("dismiss me later", 7);
    pointerUp(thread);
    expect(popup()).not.toBeNull();
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(popup()).toBeNull();
  });

  it.each(["pending", "mounted"])("keeps a %s selection when another pane retires", (phase) => {
    const thread = selection("Keep this selection", 4);
    pointerUp(thread, { onAskSideChat: onAskSideChatSpy }, false);
    if (phase === "mounted") {
      vi.runAllTimers();
    }
    removeChatSelectionPopup("pane-b");
    vi.runAllTimers();
    expect(popup()).not.toBeNull();
    removeChatSelectionPopup("pane-a");
    expect(popup()).toBeNull();
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
        expect(dialog() !== null).toBe(offset !== 100);
      }
      expect(onSave).toHaveBeenCalledWith("日本語");
    },
  );

  it("preserves unsaved comments when legacy Escape dismisses IME candidates", () => {
    const { input, onSave, onCancel } = editor({ expanded: true });
    input.value = "変換中のコメント";
    const escape = key(input, "Escape", { cancelable: true, keyCode: 229 });
    expect(escape.defaultPrevented).toBe(false);
    expect(dialog()).not.toBeNull();
    expect(input.value).toBe("変換中のコメント");
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    key(input, "Escape");
    expect(dialog()).toBeNull();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps rejected saves editable and retires a stale owner", () => {
    const controller = new AbortController();
    const onSave = vi.fn(() => false);
    const { input } = editor({ readSignal: controller.signal, onSave });
    key(input, "Enter");
    expect(dialog()).not.toBeNull();
    controller.abort();
    expect(dialog()).toBeNull();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("deletes only through the explicit Delete control", () => {
    const onDelete = vi.fn();
    const { onSave } = editor({ expanded: true, onDelete });
    document.querySelector<HTMLButtonElement>(".chat-annotation-editor__delete")!.click();
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("keeps an unsaved comment when a layout change scrolls the transcript", () => {
    const { input, onSave, onCancel } = editor();
    input.value = "Short layout control.";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // Compensation for a width or height change scrolls the transcript the
    // anchor lives in; that is not the user dismissing the editor.
    scrollTranscript();
    expect(document.querySelector(".chat-annotation-editor")).not.toBeNull();
    expect(input.value).toBe("Short layout control.");
    expect(document.activeElement).toBe(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps an unsaved comment when resizing the viewport", () => {
    const { input, onCancel } = editor();
    input.value = "873 characters that must survive the resize.";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    window.dispatchEvent(new Event("resize"));

    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    expect(input.value).toBe("873 characters that must survive the resize.");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("still closes an untouched editor when the transcript scrolls", () => {
    editor({ comment: "Saved comment", expanded: true });
    scrollTranscript();
    expect(dialog()).toBeNull();
  });

  it.each([
    [
      "an outside interaction",
      () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    ],
    ["Escape", () => key(document, "Escape")],
    ["its owner retiring the pane", () => removeChatSelectionPopup("pane-a")],
  ])("still dismisses the editor through %s", (_name, dismiss) => {
    editor();
    dismiss();
    expect(dialog()).toBeNull();
  });
});
