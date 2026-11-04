import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  composerInputHasFocus,
  focusComposerInput,
  selectComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import { mountComposerEditor } from "./components/composer-editor-view.tsx";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((stop) => stop());
  document.body.replaceChildren();
});

function fixture(kind: "chat" | "new-session", text = "Ask @Alex after", width = 230) {
  const surface = document.createElement("div");
  surface.className = "agent-chat__input";
  surface.style.cssText = `width: ${width}px; --chat-composer-editor-size:14px; --chat-composer-editor-line:20px; --chat-composer-editor-inset-block:0px; --chat-composer-editor-inset-inline:0px; --chat-composer-editor-max-lines:3; font:14px/20px Arial;`;
  const wrapper = document.createElement("div");
  wrapper.className = "agent-chat__composer-combobox";
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Message");
  input.setAttribute("aria-keyshortcuts", "Control+Enter");
  if (kind === "new-session") {
    input.className = "new-session-page__message";
  }
  input.value = text;
  let raw = text;
  const inputEvents: InputEvent[] = [];
  let mentions: readonly HumanMention[] = [
    { profileId: "alex-one", start: text.indexOf("@"), end: text.indexOf("@") + 5 },
  ];
  input.addEventListener("input", (event) => {
    inputEvents.push(event as InputEvent);
    mentions = updateHumanMentions(raw, input.value, mentions);
    raw = input.value;
    queueMicrotask(() => syncComposerInput(input));
  });
  wrapper.append(input);
  surface.append(wrapper);
  document.body.append(surface);
  const editor = mountComposerEditor(input, () => mentions);
  cleanups.push(() => {
    editor.destroy();
    surface.remove();
  });
  const content = wrapper.querySelector<HTMLElement>('[data-composer-editor="true"]')!;
  const view = EditorView.findFromDOM(content)!;
  return { input, surface, content, view, raw: () => raw, mentions: () => mentions, inputEvents };
}

async function layout() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

describe.each(["chat", "new-session"] as const)("%s document-aware composer", (kind) => {
  it("reserves a full font-sized avatar and gap before editable name text, with honest caret/wrap geometry", async () => {
    const f = fixture(kind);
    await layout();
    const avatar = f.surface.querySelector<HTMLElement>(".markdown-person-reference__avatar")!;
    const label = f.surface.querySelector<HTMLElement>(".chat-composer-mention-label")!;
    expect(label.classList.contains("markdown-person-reference")).toBe(true);
    expect(label.contains(avatar)).toBe(true);
    const font = Number.parseFloat(getComputedStyle(label).fontSize);
    const rect = avatar.getBoundingClientRect();
    const nameNode = [...label.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("Alex"),
    )!;
    const nameRange = document.createRange();
    nameRange.selectNodeContents(nameNode);
    const name = nameRange.getBoundingClientRect();
    expect(Math.abs(rect.width - font)).toBeLessThan(0.1);
    expect(Math.abs(rect.height - font)).toBeLessThan(0.1);
    expect(name.left - rect.right).toBeGreaterThanOrEqual(2);
    expect(f.surface.querySelectorAll('[role="textbox"]')).toHaveLength(1);
    expect(f.content.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(f.input.hidden).toBe(true);
    expect(f.input.getBoundingClientRect().width).toBe(0);
    expect(f.view.dom.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(f.view.state.doc.toString()).toBe("Ask @Alex after");
    expect(f.view.coordsAtPos(5)!.left).toBeCloseTo(name.left, 0);
    // The end position is outside the shared pill's trailing padding.
    expect(f.view.coordsAtPos(9)!.left).toBeCloseTo(label.getBoundingClientRect().right, 0);
    f.surface.style.width = "70px";
    await layout();
    const after = f.view.coordsAtPos(f.view.state.doc.length)!;
    expect(after.bottom).toBeGreaterThan(f.view.coordsAtPos(0)!.bottom);
    expect(after.left).toBeGreaterThanOrEqual(f.content.getBoundingClientRect().left);
    expect(after.right).toBeLessThanOrEqual(f.content.getBoundingClientRect().right + 1);
  });

  it("types around a mention, edits its name, deletes its avatar and preserves native undo/redo", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 0, 0);
    await userEvent.keyboard("Hello ");
    expect(f.raw()).toBe("Hello Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 10, end: 15 }]);
    selectComposerInput(f.input, 15, 15);
    await userEvent.keyboard("!");
    expect(f.raw()).toBe("Hello Ask @Alex! after");
    expect(f.surface.querySelector(".chat-composer-editor")).toBe(f.view.dom);
    selectComposerInput(f.input, 11, 11);
    await userEvent.keyboard("{Backspace}");
    expect(f.raw()).toBe("Hello Ask Alex! after");
    expect(f.mentions()).toEqual([]);
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(f.raw()).toContain("@Alex");
    await userEvent.keyboard("{Control>}y{/Control}");
    expect(f.raw()).not.toContain("@");
    expect(f.inputEvents.at(-1)?.inputType).toBe("historyRedo");
    expect(f.inputEvents.at(-1)?.data).toBeNull();
    expect(composerInputHasFocus(f.input)).toBe(true);
  });

  it("copies and cuts plain raw @Name, pastes raw text and keeps offsets unchanged", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 4, 9);
    const copy = new DataTransfer();
    f.content.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: copy }),
    );
    expect(copy.getData("text/plain")).toBe("@Alex");
    const cut = new DataTransfer();
    f.content.dispatchEvent(
      new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: cut }),
    );
    expect(cut.getData("text/plain")).toBe("@Alex");
    expect(f.raw()).toBe("Ask  after");
    const paste = new DataTransfer();
    paste.setData("text/plain", "@Alex");
    f.content.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: paste }),
    );
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.inputEvents.at(-1)?.inputType).toBe("insertFromPaste");
    expect(f.inputEvents.at(-1)?.data).toBeNull();
    expect(f.view.state.doc.length).toBe(f.raw().length);
    expect(f.mentions()).toEqual([]); // Pasted labels never invent recipients.
  });

  it("forwards composition and send keys through the raw controller port, honoring read-only/disabled", async () => {
    const f = fixture(kind);
    const events: string[] = [];
    for (const name of ["compositionstart", "compositionend"]) {
      f.input.addEventListener(name, () => events.push(name));
    }
    f.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        events.push("send");
        event.preventDefault();
      }
    });
    focusComposerInput(f.input);
    selectComposerInput(f.input, f.raw().length, f.raw().length);
    f.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    // Real IME candidate windows cannot be automated. Exercise CM's DOM observer
    // and production composition bridge rather than mutating the backing textarea.
    const last = f.content.querySelector(".cm-line")!.lastChild!;
    last.textContent += "に";
    f.content.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "に",
        isComposing: true,
      }),
    );
    f.content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "に" }));
    await expect.poll(f.raw).toBe("Ask @Alex afterに");
    await userEvent.keyboard("{Enter}");
    expect(events).toEqual(["compositionstart", "compositionend", "send"]);
    expect(f.raw()).not.toContain("\n");
    f.input.readOnly = true;
    syncComposerInput(f.input);
    await userEvent.keyboard("x");
    expect(f.raw()).toBe("Ask @Alex afterに");
    f.input.disabled = true;
    syncComposerInput(f.input);
    await expect.poll(() => f.content.getAttribute("contenteditable")).toBe("false");
    expect(composerInputHasFocus(f.input)).toBe(false);
  });

  it("keeps the focused caret visible when a compact pane shrinks the real scrollport", async () => {
    const f = fixture(kind, `@Alex ${"word ".repeat(160)}`);
    focusComposerInput(f.input);
    selectComposerInput(f.input, f.raw().length, f.raw().length);
    await layout();
    Object.assign(f.view.dom.style, {
      height: "25px",
      minHeight: "25px",
      maxHeight: "25px",
      paddingBlock: "2px",
    });
    await expect
      .poll(() => {
        const caret = f.view.coordsAtPos(f.view.state.selection.main.head)!;
        const scroll = f.view.scrollDOM.getBoundingClientRect();
        return caret.top >= scroll.top - 1 && caret.bottom <= scroll.bottom + 1;
      })
      .toBe(true);
    expect(f.view.scrollDOM.scrollHeight).toBeGreaterThan(f.view.scrollDOM.clientHeight);
  });

  it("keeps name characters editable and supports forward deletion of the avatar character", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 7, 7);
    await userEvent.keyboard("x");
    expect(f.raw()).toBe("Ask @Alxex after");
    expect(f.mentions()).toEqual([]);
    expect(f.view.state.selection.main.head).toBe(8);
    selectComposerInput(f.input, 4, 4);
    await userEvent.keyboard("{Delete}");
    expect(f.raw()).toBe("Ask Alxex after");
  });

  it("autosizes and scrolls the actual editor, then reflows when its pane widens", async () => {
    const f = fixture(kind, "Ask @Alex after " + "long words ".repeat(12), 160);
    await layout();
    const before = f.view.dom.getBoundingClientRect().height;
    expect(before).toBeLessThanOrEqual(61);
    expect(f.view.scrollDOM.scrollHeight).toBeGreaterThan(f.view.scrollDOM.clientHeight);
    focusComposerInput(f.input);
    selectComposerInput(f.input, f.raw().length, f.raw().length);
    await layout();
    const caret = f.view.coordsAtPos(f.raw().length)!;
    expect(caret.bottom).toBeLessThanOrEqual(f.view.scrollDOM.getBoundingClientRect().bottom + 1);
    f.surface.style.width = "1000px";
    await layout();
    expect(f.view.dom.getBoundingClientRect().height).toBeLessThan(before);
  });
});
