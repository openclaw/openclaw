import { render } from "lit";
import MarkdownIt from "markdown-it";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextareaTokenAnchor } from "../../components/textarea-token-anchor.ts";
/* @vitest-environment jsdom */
import { NewSessionComposerTextareaController } from "../new-session/composer-controller.ts";
import { renderNewSessionComposer } from "../new-session/composer.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

const controllers: NewSessionComposerTextareaController[] = [];
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(async () => {
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  controllers.splice(0).forEach((controller) => controller.disconnect());
  await resetComposerFixture();
});
beforeEach(() => {
  // jsdom has no layout/ResizeObserver; real-browser tests cover placement and cleanup.
  vi.spyOn(TextareaTokenAnchor.prototype, "update").mockImplementation(() => {});
  // jsdom has no editing engine. Exercise the browser command's input contract;
  // native undo itself is covered by the real-browser composer suite.
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn((_command: string, _ui: boolean, text: string) => {
      const textarea = document.activeElement;
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Expected focused composer");
      }
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
      return true;
    }),
  });
});

function fixture(kind: "chat" | "new", locked = false) {
  const container = document.createElement("div");
  document.body.append(container);
  let draft = "";
  const send = vi.fn();
  const controller = new NewSessionComposerTextareaController();
  controllers.push(controller);
  const props = createComposerProps({
    canSend: !locked,
    getDraft: () => draft,
    onSend: send,
    onDraftChange: (next) => {
      draft = next;
    },
    onRequestUpdate: () => redraw(),
  });
  function redraw() {
    render(
      kind === "chat"
        ? renderChatComposer({ ...props, draft })
        : renderNewSessionComposer({
            attachments: [],
            getAttachments: () => [],
            canSubmit: true,
            message: draft,
            pendingAttachmentReads: 0,
            readSignal: new AbortController().signal,
            requiresModifier: false,
            submitting: false,
            messageLocked: locked,
            textareaController: controller,
            requestUpdate: redraw,
            onAttachmentsChange: () => {},
            onPendingReadsChange: () => {},
            onInput: (next) => {
              draft = next;
              redraw();
            },
            onSubmit: send,
          }),
      container,
    );
  }
  redraw();
  const textarea = container.querySelector("textarea")!;
  textarea.focus();
  const input = (value: string, caret = value.length) => {
    textarea.value = value;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value.at(-1) }),
    );
  };
  const key = (keyName: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: keyName,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    textarea.dispatchEvent(event);
    return event;
  };
  const colon = () => {
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: ":",
    });
    textarea.dispatchEvent(event);
    return event;
  };
  return { container, textarea, input, key, colon, send, draft: () => draft };
}

describe.each(["chat", "new"] as const)("%s emoji composer", (kind) => {
  it("navigates accessible suggestions and inserts only the caret token without sending", () => {
    const f = fixture(kind);
    f.input("Before :smi after", 11);
    const list = f.container.querySelector('[role="listbox"]')!;
    expect(list.getAttribute("aria-label")).toBe("Emoji suggestions");
    expect(f.textarea.getAttribute("aria-controls")).toBe(list.id);
    const first = f.textarea.getAttribute("aria-activedescendant");
    expect(f.key("ArrowDown").defaultPrevented).toBe(true);
    expect(f.textarea.getAttribute("aria-activedescendant")).not.toBe(first);
    f.key("ArrowUp");
    expect(f.key("Enter").defaultPrevented).toBe(true);
    expect(f.draft()).toBe("Before 😄 after");
    expect(f.textarea.selectionStart).toBe(9);
    expect(document.activeElement).toBe(f.textarea);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("supports mouse and Tab acceptance and persistent Escape dismissal", () => {
    const f = fixture(kind);
    f.input(":smi");
    f.key("Escape");
    f.textarea.dispatchEvent(new Event("select"));
    expect(f.container.querySelector('[role="listbox"]')).toBeNull();
    expect(f.draft()).toBe(":smi");
    f.input(":smil");
    f.container.querySelector<HTMLElement>('[role="option"]')!.click();
    expect(f.draft()).toBe("😄");
    f.input(":thumbsup");
    f.key("Tab");
    expect(f.draft()).toBe("👍");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("converts a typed closing colon through the draft owner, not paste or undo", () => {
    const f = fixture(kind);
    f.input("Hi :smile");
    expect(f.colon().defaultPrevented).toBe(true);
    expect(f.draft()).toBe("Hi 😄");
    f.input(":smile:");
    expect(f.draft()).toBe(":smile:");
    f.textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
    expect(f.draft()).toBe(":smile:");
  });
  it.each([
    "`:smile",
    "`a\\` b ` :smile",
    "```text\n:smile",
    "~~~~\n:smile",
    "    :smile",
    ">     :smile",
    "-     :smile",
    "> -     :smile",
    "~~~\n    ~~~\n:smile",
    "~~~\n> ~~~\n:smile",
    " \t:smile",
    "https://example.com/:smile",
    "mailto:person@example.com?subject=:smile",
    "[link](:smile",
    "[x](foo(bar)(:smile",
    "\\:smile",
    ":not_a_real_emoji",
    "/echo :smile",
    "$skill:smi",
  ])("keeps literal or command context %s", (value) => {
    const f = fixture(kind);
    f.input(value);
    expect(f.colon().defaultPrevented).toBe(false);
    expect(f.container.querySelector('[aria-label="Emoji suggestions"]')).toBeNull();
    expect(f.draft()).toBe(value);
  });
  it.each([
    "Use `code` :smile",
    "Use `[link](` :smile",
    "Use `<tag` :smile",
    "😄:smile",
    "See <https://example.com/it's> :smile",
    "See <o'brien@example.com> :smile",
    "Use \\`literal :smile",
    "~~~\nif (a < b) {}\n~~~\n\nNice :smile",
    "| Status |\n| --- |\n| :smile",
    "| A | B |\n| --- | --- |\n| :smile",
  ])("converts prose after inline syntax: %s", (value) => {
    const f = fixture(kind);
    f.input(value);
    expect(f.colon().defaultPrevented).toBe(true);
    expect(f.draft()).toBe(value.replace(":smile", "😄"));
  });
  it("avoids Markdown work for ordinary typing and reuses an unchanged shortcode context", () => {
    const parse = vi.spyOn(MarkdownIt.prototype, "parse");
    try {
      const f = fixture(kind);
      f.input("Ordinary typing");
      f.input(":zzzzunknown");
      expect(parse).not.toHaveBeenCalled();
      f.input("Nice :s");
      f.input("Nice :sm");
      f.input("Nice :smi");
      f.textarea.dispatchEvent(new Event("select"));
      expect(parse).toHaveBeenCalledTimes(1);
      f.input("`Nice :smi");
      expect(f.container.querySelector('[aria-label="Emoji suggestions"]')).toBeNull();
      f.input("Nice :smi");
      expect(f.container.querySelector('[aria-label="Emoji suggestions"]')).not.toBeNull();
      expect(parse).toHaveBeenCalledTimes(3);
    } finally {
      parse.mockRestore();
    }
  });
  it("handles a first lookup after a large unbroken token without a multi-second stall", () => {
    const f = fixture(kind);
    const draft = "a".repeat(100_000) + " :smi";
    const started = performance.now();
    f.input(draft);
    expect(f.container.querySelector('[aria-label="Emoji suggestions"]')).not.toBeNull();
    // Deliberately generous: catch quadratic stalls, not ordinary CI timing variation.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
  it("ignores a queued selection event after focus leaves the composer", () => {
    const f = fixture(kind);
    f.input(":smi");
    f.textarea.setSelectionRange(4, 4);
    f.textarea.blur();
    f.textarea.dispatchEvent(new Event("select"));
    expect(f.container.querySelector('[aria-label="Emoji suggestions"]')).toBeNull();
    expect(f.draft()).toBe(":smi");
  });
  it("leaves IME composition and locked text alone", () => {
    const f = fixture(kind);
    f.input(":smi");
    f.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(f.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(f.colon().defaultPrevented).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    const locked = fixture(kind, true);
    locked.input(":smile");
    expect(locked.colon().defaultPrevented).toBe(false);
    expect(locked.container.querySelector('[aria-label="Emoji suggestions"]')).toBeNull();
  });
});
