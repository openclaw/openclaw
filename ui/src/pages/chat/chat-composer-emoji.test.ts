import MarkdownIt from "markdown-it";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Overlay } from "../../components/overlay-lifecycle.ts";
import * as textareaAnchor from "../../components/textarea-token-anchor.ts";
import * as idleImport from "../../lib/idle-import.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
/* @vitest-environment jsdom */
import {
  renderComposer as renderNewComposer,
  resetComposerTestFixtures,
} from "../new-session/composer.test-support.ts";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

const createIdleImport = idleImport.createIdleImport;
const inputEvent = (data: string | undefined, type = "input") =>
  new InputEvent(type, {
    bubbles: true,
    cancelable: type === "beforeinput",
    inputType: "insertText",
    data,
  });
async function settleImports() {
  await vi.dynamicImportSettled();
  flush();
}
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
      textarea.dispatchEvent(inputEvent(text));
      return true;
    }),
  });
});

async function fixture(
  kind: "chat" | "new" = "chat",
  initial = "",
  locked = false,
  requiresModifier = false,
  restored = false,
) {
  let draft = restored ? initial : "";
  const send = vi.fn();
  const backgroundSend = vi.fn();
  const onInput = (next: string) => {
    draft = next;
  };
  const container =
    kind === "new"
      ? renderNewComposer({
          draftOwnerKey: "emoji",
          message: draft,
          requiresModifier,
          messageLocked: locked,
          onInput,
          onSubmit: send,
          onBackgroundSubmit: backgroundSend,
        }).container
      : renderComposerFixture({
          canSend: !locked,
          draft,
          getDraft: () => draft,
          onSend: send,
          onDraftChange: onInput,
        }).container;
  document.body.append(container);
  const textarea = container.querySelector("textarea")!;
  const menu = () => container.querySelector('[aria-label="Emoji suggestions"]');
  textarea.focus();
  const dispatch = <T extends Event>(event: T) => {
    textarea.dispatchEvent(event);
    flush();
    return event;
  };
  const closed = (value: string) => {
    expect(draft).toBe(value);
    expect(menu()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  };
  const input = (value: string, caret = value.length) => {
    textarea.value = value;
    textarea.setSelectionRange(caret, caret);
    dispatch(inputEvent(value.at(-1)));
  };
  const key = (keyName: string, extra: KeyboardEventInit = {}) =>
    dispatch(
      new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...extra }),
    );
  const colon = () => dispatch(inputEvent(":", "beforeinput"));
  if (initial && !restored) {
    input(initial);
    await settleImports();
  }
  return {
    container,
    textarea,
    menu,
    input,
    key,
    colon,
    closed,
    send,
    backgroundSend,
    draft: () => draft,
  };
}

function holdImports() {
  const gate = Promise.withResolvers<void>();
  const started = vi.fn();
  const spy = vi
    .spyOn(idleImport, "createIdleImport")
    .mockImplementation(<T>(load: () => Promise<T>, onLoaded?: (value: T) => void) =>
      createIdleImport(async () => {
        started();
        await gate.promise;
        return load();
      }, onLoaded),
    );
  onTestFinished(() => {
    gate.resolve();
    spy.mockRestore();
  });
  return { release: gate.resolve, started };
}

it("keeps native editing while cold and converts closing colons once ready", async () => {
  const imports = holdImports();
  const f = await fixture();
  f.input("Ordinary typing");
  expect(imports.started).not.toHaveBeenCalled();
  f.input(":smile");
  expect(imports.started).toHaveBeenCalledTimes(1);
  expect(textareaAnchor.createTextareaTokenAnchor).not.toHaveBeenCalled();
  expect(f.key("Tab").defaultPrevented).toBe(false);
  expect(f.colon().defaultPrevented).toBe(false);
  f.input(":smile:");
  imports.release();
  await settleImports();
  f.closed(":smile:");
  expect(textareaAnchor.createTextareaTokenAnchor).toHaveBeenCalledTimes(1);
  f.input(":smile");
  expect(f.colon().defaultPrevented).toBe(true);
  f.closed("😄");
});

it("discovers suggestions at the current draft and caret when cold data arrives", async () => {
  const imports = holdImports();
  const f = await fixture();
  f.input(":smi");
  f.input("New :hea suffix", 8);
  imports.release();
  await settleImports();
  expect(f.textarea).toMatchObject({ value: "New :hea suffix", selectionStart: 8 });
  expect(f.menu()?.textContent).toContain(":heart:");
  expect(f.key("Tab").defaultPrevented).toBe(true);
  f.closed("New 🎧 suffix");
});

it.each(["blur", "detach"])("does not reopen cold suggestions after %s", async (retirement) => {
  const imports = holdImports();
  const f = await fixture();
  f.input(":smi");
  if (retirement === "blur") {
    f.textarea.blur();
  } else {
    f.container.remove();
  }
  imports.release();
  await settleImports();
  f.closed(":smi");
});

it.each(["chat", "new"] as const)("discovers a restored %s draft on focus", async (kind) => {
  const f = await fixture(kind, ":smi", false, false, true);
  await settleImports();
  expect(f.draft()).toBe(":smi");
  expect(f.menu()).not.toBeNull();
  expect(f.key("Tab").defaultPrevented).toBe(true);
  f.closed("😄");
});

it.each(["chat", "modifier", "background"])(
  "suppresses held emoji acceptance in %s mode",
  async (mode) => {
    const f = await fixture(mode === "chat" ? "chat" : "new", ":smi", false, mode !== "chat");
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

describe.each(["chat", "new"] as const)("%s emoji composer", (kind) => {
  it("accepts before synchronous overlay retirement can dismiss the menu again", async () => {
    let overlay: Overlay | undefined;
    vi.mocked(textareaAnchor.createTextareaTokenAnchor).mockReturnValue({
      updateNative(next) {
        overlay = next;
      },
      close() {
        overlay?.retire();
      },
    });
    const f = await fixture(kind);
    f.input("Before :smi after", 11);
    await settleImports();
    expect(overlay).toBeDefined();
    const list = f.container.querySelector('[role="listbox"]')!;
    expect(list.getAttribute("aria-label")).toBe("Emoji suggestions");
    expect(f.textarea.getAttribute("aria-controls")).toBe(list.id);
    const first = f.textarea.getAttribute("aria-activedescendant");
    expect(f.key("ArrowDown").defaultPrevented).toBe(true);
    expect(f.textarea.getAttribute("aria-activedescendant")).not.toBe(first);
    f.key("ArrowUp");
    expect(f.key("Tab").defaultPrevented).toBe(true);
    f.closed("Before 😄 after");
    expect(f.textarea.selectionStart).toBe(9);
    expect(document.activeElement).toBe(f.textarea);
  });

  it.each(["blur", "Escape"])("ignores a queued selection event after %s", async (dismissal) => {
    const f = await fixture(kind, ":smi");
    f.textarea.setSelectionRange(4, 4);
    if (dismissal === "blur") {
      f.textarea.blur();
    } else {
      f.key("Escape");
    }
    f.textarea.dispatchEvent(new Event("select"));
    flush();
    f.closed(":smi");
  });

  it("leaves IME composition and locked text alone", async () => {
    const f = await fixture(kind, ":smi");
    f.textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(f.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(f.colon().defaultPrevented).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    const locked = await fixture(kind, ":smile", true);
    expect(locked.colon().defaultPrevented).toBe(false);
    expect(locked.menu()).toBeNull();
  });
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
] as const)("handles shortcode context %s (convert=%s)", async (value, convert) => {
  const f = await fixture("chat", value);
  expect(f.colon().defaultPrevented).toBe(convert);
  f.closed(convert ? value.replace(":smile", "😄") : value);
});

it("avoids Markdown work for ordinary typing and reuses an unchanged shortcode context", async () => {
  const parse = vi.spyOn(MarkdownIt.prototype, "parse");
  const f = await fixture("chat");
  f.input("Ordinary typing");
  f.input(":zzzzunknown");
  expect(parse).not.toHaveBeenCalled();
  f.input("Nice :s");
  await settleImports();
  f.input("Nice :sm");
  f.input("Nice :smi");
  f.textarea.dispatchEvent(new Event("select"));
  expect(parse).toHaveBeenCalledTimes(1);
  f.input("`Nice :smi");
  expect(f.menu()).toBeNull();
  f.input("Nice :smi");
  expect(f.menu()).not.toBeNull();
  expect(parse).toHaveBeenCalledTimes(3);
});
