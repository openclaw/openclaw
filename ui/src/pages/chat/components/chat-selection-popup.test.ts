import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleChatSelectionPointerUp,
  removeChatSelectionPopup,
  showChatAnnotationEditor,
} from "./chat-selection-popup.tsx";

// JSDOM ranges have no layout; give the popup a fixed anchor.
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(100, 100, 100, 20),
  });
});
afterAll(() => {
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

function selection(text: string, end?: number) {
  const thread = document.body.appendChild(document.createElement("div"));
  thread.className = "chat-thread";
  thread.innerHTML =
    '<div class="chat-bubble" data-message-id="assistant-1" data-entry-id="entry-1"><div class="chat-text"></div></div>';
  const body = thread.querySelector(".chat-text")!;
  body.textContent = text;
  if (end !== undefined) {
    selectRange(body.firstChild as Text, 0, end);
  }
  return thread;
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
  options: Omit<Parameters<typeof handleChatSelectionPointerUp>[1], "paneId"> = {
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

const popup = () => document.querySelector(".chat-selection-popup");
const dialog = () => document.querySelector("[role=dialog]");
function scrollTranscript() {
  const transcript = document.body.appendChild(document.createElement("div"));
  transcript.className = "chat-transcript";
  transcript.dispatchEvent(new Event("scroll", { bubbles: false }));
}
function key(
  input: EventTarget,
  value: string,
  options: KeyboardEventInit = {},
  timeStamp?: number,
) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, ...options });
  if (timeStamp !== undefined) {
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
  }
  input.dispatchEvent(event);
  return event;
}

const onAskSideChatSpy = vi.fn();
const onAddToChatSpy = vi.fn();

afterEach(() => {
  removeChatSelectionPopup();
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  onAskSideChatSpy.mockReset();
  onAddToChatSpy.mockReset();
  vi.useRealTimers();
});

describe("chat selection popup", () => {
  beforeEach(() => vi.useFakeTimers());

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
    expect(thread.isConnected).toBe(true);
  });

  it("ignores selections outside chat bubbles and collapsed selections", () => {
    const thread = selection("bubble text");
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

  it("keeps only the latest pending selection popup", () => {
    const thread = selection("replacement selection", 11);
    const firstAskSideChat = vi.fn();
    const secondAskSideChat = vi.fn();
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

  it.each(["scroll", "collapse"])("dismisses the toolbar on %s", (action) => {
    const thread = selection("dismiss me later", 7);
    pointerUp(thread);
    expect(popup()).not.toBeNull();
    if (action === "scroll") {
      scrollTranscript();
    } else {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    }
    expect(popup()).toBeNull();
  });

  it.each([
    ["pending", "pane-a", false],
    ["pending", "pane-b", true],
    ["mounted", "pane-b", true],
  ] as const)("retiring %s selection owner %s leaves popup=%s", (phase, pane, retained) => {
    const thread = selection("Keep this selection", 4);
    pointerUp(thread, { onAskSideChat: onAskSideChatSpy }, false);
    if (phase === "mounted") {
      vi.runAllTimers();
    }
    removeChatSelectionPopup(pane);
    vi.runAllTimers();
    expect(popup() !== null).toBe(retained);
    removeChatSelectionPopup("pane-a");
    expect(popup()).toBeNull();
  });
});

describe("chat annotation editor", () => {
  function editor(options: Partial<Parameters<typeof showChatAnnotationEditor>[0]> = {}) {
    const callbacks = { onSave: vi.fn(), onCancel: vi.fn() };
    showChatAnnotationEditor({
      paneId: "pane-a",
      anchorRect: new DOMRect(100, 100, 100, 20),
      comment: "",
      ...callbacks,
      ...options,
    });
    return { input: document.querySelector("textarea")!, ...callbacks };
  }

  it.each([
    [{}, "keyup"],
    [{ ctrlKey: true }, "blur"],
    [{ metaKey: true }, "timeout"],
  ] as const)("ignores Safari composition Enter (%j, %s)", (modifiers, release) => {
    const { input, onSave } = editor({ comment: "日本語" });
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const end = new CompositionEvent("compositionend", { bubbles: true, data: "日本語" });
    input.dispatchEvent(end);
    for (const offset of [1, 100]) {
      if (offset === 100 && release !== "timeout") {
        input.dispatchEvent(
          release === "blur"
            ? new FocusEvent("blur")
            : new KeyboardEvent("keyup", { key: "Enter", bubbles: true }),
        );
      }
      const enter = key(
        input,
        "Enter",
        { keyCode: 13, cancelable: true, ...modifiers },
        end.timeStamp + (release === "timeout" ? offset : 1),
      );
      expect(enter.defaultPrevented).toBe(offset === 100);
      expect(onSave).toHaveBeenCalledTimes(offset === 100 ? 1 : 0);
      expect(dialog() !== null).toBe(offset !== 100);
    }
    expect(onSave).toHaveBeenCalledWith("日本語");
  });

  it.each(["legacy IME Escape", "layout scroll"])("preserves unsaved comments on %s", (action) => {
    const ime = action === "legacy IME Escape";
    const { input, onSave, onCancel } = editor({ expanded: ime });
    const text = ime ? "変換中のコメント" : "Short layout control.";
    input.value = text;
    if (ime) {
      expect(key(input, "Escape", { cancelable: true, keyCode: 229 }).defaultPrevented).toBe(false);
    } else {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      scrollTranscript();
      expect(document.querySelector(".chat-annotation-editor")).not.toBeNull();
      expect(document.activeElement).toBe(input);
    }
    expect(dialog()).not.toBeNull();
    expect(input.value).toBe(text);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    if (ime) {
      key(input, "Escape");
      expect(dialog()).toBeNull();
      expect(onCancel).toHaveBeenCalledOnce();
    }
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

  it("keeps an unsaved comment when resizing the viewport", () => {
    const { input, onCancel } = editor();
    input.value = "873 characters that must survive the resize.";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    window.dispatchEvent(new Event("resize"));

    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    expect(input.value).toBe("873 characters that must survive the resize.");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["transcript scroll", { comment: "Saved comment", expanded: true }, scrollTranscript],
    [
      "an outside interaction",
      {},
      () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    ],
    ["Escape", {}, () => key(document, "Escape")],
    ["its owner retiring the pane", {}, () => removeChatSelectionPopup("pane-a")],
  ] as const)("still dismisses an untouched editor through %s", (_name, options, dismiss) => {
    editor(options);
    dismiss();
    expect(dialog()).toBeNull();
  });
});
