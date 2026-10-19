import MarkdownIt from "markdown-it";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Overlay } from "../../components/overlay-lifecycle.ts";
import * as textareaAnchor from "../../components/textarea-token-anchor.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
/* @vitest-environment jsdom */
import {
  renderComposer as renderNewComposer,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(async () => {
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  resetComposerTestFixtures();
  await resetComposerFixture();
});
beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  // jsdom has no layout/ResizeObserver; real-browser tests cover placement and cleanup.
  vi.spyOn(textareaAnchor, "createTextareaTokenAnchor").mockReturnValue({
    updateNative() {},
    close() {},
  });
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

function fixture(
  kind: "chat" | "new" = "chat",
  initial = "",
  locked = false,
  requiresModifier = false,
) {
  let draft = "";
  const send = vi.fn();
  const backgroundSend = vi.fn();
  const onInput = (next: string) => {
    draft = next;
  };
  const container =
    kind === "new"
      ? renderNewComposer({
          draftOwnerKey: "emoji",
          requiresModifier,
          messageLocked: locked,
          onInput,
          onSubmit: send,
          onBackgroundSubmit: backgroundSend,
        }).container
      : renderComposerFixture({
          canSend: !locked,
          getDraft: () => draft,
          onSend: send,
          onDraftChange: onInput,
        }).container;
  document.body.append(container);
  const textarea = container.querySelector("textarea")!;
  textarea.focus();
  const dispatch = <T extends Event>(event: T) => {
    textarea.dispatchEvent(event);
    flush();
    return event;
  };
  const closed = (value: string) => {
    expect(draft).toBe(value);
    expect(container.querySelector('[aria-label="Emoji suggestions"]')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  };
  const input = (value: string, caret = value.length) => {
    textarea.value = value;
    textarea.setSelectionRange(caret, caret);
    dispatch(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: value.at(-1) }),
    );
  };
  const key = (keyName: string, extra: KeyboardEventInit = {}) =>
    dispatch(
      new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...extra }),
    );
  const colon = () =>
    dispatch(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: ":",
      }),
    );
  if (initial) {
    input(initial);
  }
  return {
    container,
    textarea,
    input,
    key,
    colon,
    closed,
    send,
    backgroundSend,
    draft: () => draft,
  };
}

it.each(["chat", "modifier", "background"])(
  "suppresses held emoji acceptance in %s mode",
  (mode) => {
    const f = fixture(mode === "chat" ? "chat" : "new", ":smi", false, mode !== "chat");
    const keys = mode === "background" ? { ctrlKey: true, shiftKey: true } : {};
    f.key("Enter");
    f.closed("😄");
    expect(f.key("Enter", { ...keys, repeat: true }).defaultPrevented).toBe(true);
    f.closed("😄");
    expect(f.backgroundSend).not.toHaveBeenCalled();
    if (mode === "modifier") {
      f.textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      expect(f.key("Enter").defaultPrevented).toBe(false);
      expect(f.key("Enter", { repeat: true }).defaultPrevented).toBe(false);
      expect(f.send).not.toHaveBeenCalled();
    } else {
      expect(f.key("Enter", keys).defaultPrevented).toBe(true);
      expect(mode === "chat" ? f.send : f.backgroundSend).toHaveBeenCalledTimes(1);
    }
  },
);

it("supports mouse and Tab acceptance and persistent Escape dismissal", () => {
  const f = fixture("chat", ":smi");
  f.key("Escape");
  f.textarea.dispatchEvent(new Event("select"));
  flush();
  f.closed(":smi");
  f.input(":smil");
  f.container.querySelector<HTMLElement>('[role="option"]')!.click();
  expect(f.draft()).toBe("😄");
  f.input(":thumbsup");
  f.key("Tab");
  f.closed("👍");
});

describe.each(["chat", "new"] as const)("%s emoji composer", (kind) => {
  it("accepts before synchronous overlay retirement can dismiss the menu again", () => {
    let overlay: Overlay | undefined;
    vi.mocked(textareaAnchor.createTextareaTokenAnchor).mockReturnValue({
      updateNative(next) {
        overlay = next;
      },
      close() {
        overlay?.retire();
      },
    });
    const f = fixture(kind, "Nice :smi");
    expect(overlay).toBeDefined();
    f.key("ArrowDown");
    f.key("ArrowUp");
    expect(f.key("Tab").defaultPrevented).toBe(true);
    f.closed("Nice 😄");
  });

  it("ignores a queued selection event after focus leaves the composer", () => {
    const f = fixture(kind, ":smi");
    f.textarea.setSelectionRange(4, 4);
    f.textarea.blur();
    f.textarea.dispatchEvent(new Event("select"));
    flush();
    f.closed(":smi");
  });

  it("leaves IME composition and locked text alone", () => {
    const f = fixture(kind, ":smi");
    f.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(f.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(f.colon().defaultPrevented).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    const locked = fixture(kind, ":smile", true);
    expect(locked.colon().defaultPrevented).toBe(false);
    expect(locked.container.querySelector('[aria-label="Emoji suggestions"]')).toBeNull();
  });
});

it("navigates accessible suggestions and inserts only the caret token without sending", () => {
  const f = fixture("chat");
  f.input("Before :smi after", 11);
  const list = f.container.querySelector('[role="listbox"]')!;
  expect(list.getAttribute("aria-label")).toBe("Emoji suggestions");
  expect(f.textarea.getAttribute("aria-controls")).toBe(list.id);
  const first = f.textarea.getAttribute("aria-activedescendant");
  expect(f.key("ArrowDown").defaultPrevented).toBe(true);
  expect(f.textarea.getAttribute("aria-activedescendant")).not.toBe(first);
  f.key("ArrowUp");
  expect(f.key("Enter").defaultPrevented).toBe(true);
  f.closed("Before 😄 after");
  expect(f.textarea.selectionStart).toBe(9);
  expect(document.activeElement).toBe(f.textarea);
});

it.each([
  ["> -     :smile", false],
  ["../page?emoji=:smile", false],
  ["[x](foo(bar)(:smile", false],
  ["/echo :smile", false],
  ["$skill:smi", false],
  ["Use `code` :smile", true],
  ["😄:smile", true],
  ["See <o'brien@example.com> :smile", true],
  ["Use \\`literal :smile", true],
  ["~~~\nif (a < b) {}\n~~~\n\nNice :smile", true],
] as const)("handles shortcode context %s (convert=%s)", (value, convert) => {
  const f = fixture("chat", value);
  expect(f.colon().defaultPrevented).toBe(convert);
  f.closed(convert ? value.replace(":smile", "😄") : value);
});

it("avoids Markdown work for ordinary typing and reuses an unchanged shortcode context", () => {
  const parse = vi.spyOn(MarkdownIt.prototype, "parse");
  const f = fixture("chat");
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
});
