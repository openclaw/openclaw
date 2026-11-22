import { redo, undo } from "@codemirror/commands";
import { StateEffect } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import "../../test-helpers/load-styles.ts";
import "../../styles/chat/composer-surface.css";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  composerInputHasFocus,
  focusComposerInput,
  selectComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import { isApplePlatform } from "../../lib/keyboard-shortcut-contract.ts";
import { mountMentionComposerEditor } from "./components/composer-editor-mentions.tsx";
import { mountComposerEditor } from "./components/composer-editor-view.tsx";

const historyModifier = isApplePlatform() ? "Meta" : "Control";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((stop) => stop());
  document.body.replaceChildren();
});

function fixture(
  kind: "chat" | "new-session",
  text = "Ask @Alex after",
  width = 230,
  selected?: readonly HumanMention[],
  mount: (
    input: HTMLTextAreaElement,
    mentions: () => readonly HumanMention[],
  ) => { destroy: () => void } = mountMentionComposerEditor,
) {
  const surface = document.createElement("div");
  surface.className = "agent-chat__input";
  surface.style.cssText = `width: ${width}px; --chat-composer-editor-size:14px; --chat-composer-editor-line:20px; --chat-composer-editor-inset-block:0px; --chat-composer-editor-inset-inline:0px; --chat-composer-editor-max-lines:3; --chat-composer-min-height:0px; font:14px/20px Arial;`;
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
  let mentions: readonly HumanMention[] = selected ?? [
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
  const editor = mount(input, () => mentions);
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
  it.each(["'", "’"])(
    "attaches a typed %s possessive without losing the chip or undo",
    async (quote) => {
      const f = fixture(kind, "@Alex ", 230, [{ profileId: "alex-one", start: 0, end: 5 }]);
      focusComposerInput(f.input);
      selectComposerInput(f.input, 6, 6);
      await userEvent.keyboard(quote);
      expect(undo(f.view)).toBe(true);
      expect(f.raw()).toBe("@Alex ");
      expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 0, end: 5 }]);
      expect(redo(f.view)).toBe(true);
      expect(f.raw()).toBe("@Alex" + quote);
      await userEvent.keyboard("s");
      expect(f.raw()).toBe("@Alex" + quote + "s");
      selectComposerInput(f.input, 0, 0);
      await userEvent.keyboard(quote);
      expect(f.raw()).toBe(quote + "@Alex" + quote + "s");
      expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 1, end: 6 }]);
    },
  );

  it("reuses mapped mention state on owner echoes while refreshing changed avatars", async () => {
    const avatarUrls = new Map<string, string>();
    const f = fixture(kind, "Ask @Alex after", 800, undefined, (input, mentions) =>
      mountMentionComposerEditor(input, mentions, undefined, undefined, avatarUrls),
    );
    focusComposerInput(f.input);
    selectComposerInput(f.input, 0, 0);
    await layout();
    let reconciliations = 0;
    f.view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          reconciliations += update.transactions.filter(
            (transaction) => !transaction.docChanged && transaction.isUserEvent("input.complete"),
          ).length;
        }),
      ),
    });
    await userEvent.keyboard("Hello ");
    await layout();
    expect(f.raw()).toBe("Hello Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 10, end: 15 }]);
    expect(reconciliations).toBe(0);
    const avatar = "/api/users/alex-one/avatar?v=mapped-echo";
    avatarUrls.set("alex-one", avatar);
    syncComposerInput(f.input);
    await layout();
    expect(f.content.querySelector(".chat-composer-mention img")?.getAttribute("src")).toBe(avatar);
    expect(reconciliations).toBe(1);
    syncComposerInput(f.input);
    await layout();
    expect(reconciliations).toBe(1);
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 10, end: 15 }]);
  });

  it("fits the compact conversation height after activating a chip", async () => {
    const f = fixture(kind);
    const pane = document.createElement("div");
    pane.style.cssText = "container:chat-conversation / size; width:230px; height:150px";
    document.body.append(pane);
    pane.append(f.surface);
    await layout();
    expect(getComputedStyle(f.view.dom).paddingBlock).toBe("2px");
    expect(f.view.dom.getBoundingClientRect().height).toBe(24);
  });

  it("keeps required separators when deleting whitespace beside a chip", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 9, 9);
    await userEvent.keyboard("{Delete}");
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 4, end: 9 }]);
    selectComposerInput(f.input, 4, 4);
    await userEvent.keyboard("{Backspace}");
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.mentions()).toHaveLength(1);
    // The kept separator is stepped over, so a second Backspace is not a dead key.
    expect(f.view.state.selection.main.head).toBe(3);
    selectComposerInput(f.input, 10, 10);
    await userEvent.keyboard("{Backspace}");
    expect(f.view.state.selection.main.head).toBe(9);
    await userEvent.keyboard("{Backspace}");
    expect(f.raw()).toBe("Ask  after");
    expect(f.mentions()).toEqual([]);
  });

  it("keeps a composition undo separate from earlier draft edits", async () => {
    const f = fixture(kind);
    f.view.dispatch({ changes: { from: 0, insert: "Hello " }, userEvent: "input.type" });
    selectComposerInput(f.input, 15, 15);
    focusComposerInput(f.input);
    f.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const position = f.view.state.selection.main.head;
    f.view.dispatch({
      changes: { from: position, insert: "你" },
      selection: { anchor: position + 1 },
      userEvent: "input.type.compose",
    });
    f.content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
    expect(f.raw()).toBe("Hello Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 10, end: 15 }]);
  });

  it("cancels composition padding without resurrecting it in undo", async () => {
    const f = fixture(kind);
    f.view.dispatch({ changes: { from: 0, insert: "Hello " }, userEvent: "input.type" });
    selectComposerInput(f.input, 15, 15);
    focusComposerInput(f.input);
    f.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    f.content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    expect(f.raw()).toBe("Hello Ask @Alex after");
    await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 4, end: 9 }]);
  });

  it.each([
    [0, 4],
    [9, 10],
  ])("preserves chips when IME replaces adjacent selection %s..%s", (start, end) => {
    const f = fixture(kind);
    selectComposerInput(f.input, start, end);
    f.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    f.view.dispatch({ ...f.view.state.replaceSelection("你"), userEvent: "input.type.compose" });
    f.content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    expect(f.raw()).toBe(start === 0 ? "你 @Alex after" : "Ask @Alex 你after");
    expect(f.mentions()).toEqual([
      { profileId: "alex-one", start: start === 0 ? 2 : 4, end: start === 0 ? 7 : 9 },
    ]);
  });

  it.each([4, 9])("retains recipients during composition beside a chip at %s", (at) => {
    const f = fixture(kind);
    selectComposerInput(f.input, at, at);
    // Exercise CM's composition transaction contract; not an OS IME claim.
    f.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const position = f.view.state.selection.main.head;
    f.view.dispatch({
      changes: { from: position, insert: "你" },
      selection: { anchor: position + 1 },
      userEvent: "input.type.compose",
    });
    expect(f.raw()).toBe(at === 4 ? "Ask 你 @Alex after" : "Ask @Alex 你 after");
    expect(f.mentions()).toEqual([
      { profileId: "alex-one", start: at === 4 ? 6 : 4, end: at === 4 ? 11 : 9 },
    ]);
  });

  it("cuts the intended identical label without stripping the other person", async () => {
    const f = fixture(kind, "@Alex @Alex", 230, [
      { profileId: "alex-one", start: 0, end: 5 },
      { profileId: "alex-two", start: 6, end: 11 },
    ]);
    selectComposerInput(f.input, 0, 6);
    f.content.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      }),
    );
    expect(f.raw()).toBe("@Alex");
    expect(f.mentions()).toEqual([{ profileId: "alex-two", start: 0, end: 5 }]);
    for (let cycle = 0; cycle < 2; cycle++) {
      focusComposerInput(f.input);
      await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
      expect(f.raw()).toBe("@Alex @Alex");
      expect(f.mentions()).toEqual([
        { profileId: "alex-one", start: 0, end: 5 },
        { profileId: "alex-two", start: 6, end: 11 },
      ]);
      await userEvent.keyboard(`{${historyModifier}>}{Shift>}Z{/Shift}{/${historyModifier}}`);
      expect(f.raw()).toBe("@Alex");
      expect(f.mentions()).toEqual([{ profileId: "alex-two", start: 0, end: 5 }]);
    }
  });

  it("pads incoming chip metadata when pasted into an ordinary word", () => {
    const f = fixture(kind);
    selectComposerInput(f.input, 12, 12);
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "@Bob");
    clipboard.setData(
      "application/x-openclaw-mentions",
      JSON.stringify([{ profileId: "bob", start: 0, end: 4 }]),
    );
    f.content.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
    expect(f.raw()).toBe("Ask @Alex af @Bob ter");
    expect(f.mentions()).toEqual([
      { profileId: "alex-one", start: 4, end: 9 },
      { profileId: "bob", start: 13, end: 17 },
    ]);
  });

  it("preserves clipboard recipients when a chip-boundary separator is inserted", async () => {
    const f = fixture(kind);
    selectComposerInput(f.input, 4, 9);
    const clipboard = new DataTransfer();
    f.content.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
    selectComposerInput(f.input, 4, 4);
    f.content.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
    expect(f.raw()).toBe("Ask @Alex @Alex after");
    expect(f.mentions()).toEqual([
      { profileId: "alex-one", start: 4, end: 9 },
      { profileId: "alex-one", start: 10, end: 15 },
    ]);
  });

  it("renders the selected person as one sent-style chip with real avatar width and honest wrapping", async () => {
    const f = fixture(kind);
    await layout();
    const chips = f.surface.querySelectorAll<HTMLElement>(".chat-composer-mention");
    expect(chips).toHaveLength(1);
    const chip = chips[0]!;
    expect(chip.classList.contains("markdown-person-reference")).toBe(true);
    expect(chip.getAttribute("contenteditable")).toBe("false");
    const avatar = chip.querySelector<HTMLElement>(".markdown-person-reference__avatar")!;
    const chipText = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT);
    let nameNode = chipText.nextNode();
    while (nameNode && nameNode.textContent !== "Alex") {
      nameNode = chipText.nextNode();
    }
    const range = document.createRange();
    range.selectNodeContents(nameNode!);
    const font = Number.parseFloat(getComputedStyle(chip).fontSize);
    const rect = avatar.getBoundingClientRect();
    // The composer reuses the sent-message avatar: a font-sized circle and gap.
    expect(rect.width).toBeGreaterThanOrEqual(font);
    expect(rect.height).toBeGreaterThanOrEqual(font);
    expect(range.getBoundingClientRect().left - rect.right).toBeGreaterThanOrEqual(2);
    expect(f.surface.querySelectorAll('[role="textbox"]')).toHaveLength(1);
    expect(f.content.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(f.input.hidden).toBe(true);
    expect(f.input.getBoundingClientRect().width).toBe(0);
    // One document, no overlay: the raw text exists once and the chip replaces it.
    expect(f.view.state.doc.toString()).toBe("Ask @Alex after");
    const nameNodes: Node[] = [];
    const walker = document.createTreeWalker(f.content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes("Alex")) {
        nameNodes.push(node);
      }
    }
    expect(nameNodes).toHaveLength(1);
    expect(f.view.coordsAtPos(4)!.right).toBeCloseTo(chip.getBoundingClientRect().left, 0);
    // Measure the widget side; WebKit rounds the following text range differently.
    expect(f.view.coordsAtPos(9, -1)!.left).toBeCloseTo(chip.getBoundingClientRect().right, 0);
    f.surface.style.width = "70px";
    await layout();
    const after = f.view.coordsAtPos(f.view.state.doc.length)!;
    expect(after.bottom).toBeGreaterThan(f.view.coordsAtPos(0)!.bottom);
    expect(after.right).toBeLessThanOrEqual(f.content.getBoundingClientRect().right + 1);
  });

  it("keeps one text-sized caret across mention boundaries", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    const heights: number[] = [];
    for (const position of [3, 4, 9, 10]) {
      selectComposerInput(f.input, position, position);
      await layout();
      const cursors = f.view.dom.querySelectorAll<HTMLElement>(".cm-cursor-primary");
      expect(cursors).toHaveLength(1);
      const cursor = cursors[0]!;
      const rect = cursor.getBoundingClientRect();
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.height).toBeLessThanOrEqual(20);
      heights.push(rect.height);
      expect(getComputedStyle(f.content).caretColor).toBe("rgba(0, 0, 0, 0)");
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    selectComposerInput(f.input, 4, 9);
    await layout();
    expect(f.view.dom.querySelectorAll(".cm-cursor-primary")).toHaveLength(0);
    expect(f.view.dom.querySelector(".cm-selectionBackground")).not.toBeNull();
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 4, end: 9 }]);
  });

  it("moves, selects and clicks over a mention as one character", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 4, 4);
    await userEvent.keyboard("{ArrowRight}");
    expect(f.view.state.selection.main.head).toBe(9);
    await userEvent.keyboard("{ArrowLeft}");
    expect(f.view.state.selection.main.head).toBe(4);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect([f.view.state.selection.main.from, f.view.state.selection.main.to]).toEqual([4, 9]);
    await userEvent.keyboard("{ArrowLeft}");
    await layout();
    const chip = f.surface
      .querySelector<HTMLElement>(".chat-composer-mention")!
      .getBoundingClientRect();
    for (const ratio of [0.2, 0.5, 0.8]) {
      await userEvent.click(f.content, {
        position: {
          x: chip.left + chip.width * ratio - f.content.getBoundingClientRect().left,
          y: chip.top + chip.height / 2 - f.content.getBoundingClientRect().top,
        },
      });
      expect([4, 9]).toContain(f.view.state.selection.main.head);
    }
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.mentions()).toHaveLength(1);
    // Double-click word selection inside the chip widens to the whole chip.
    await userEvent.dblClick(f.surface.querySelector(".chat-composer-mention")!);
    expect([f.view.state.selection.main.from, f.view.state.selection.main.to]).toEqual([4, 9]);
    // Programmatic selections can never split a chip either.
    selectComposerInput(f.input, 6, 6);
    expect([4, 9]).toContain(f.view.state.selection.main.head);
    selectComposerInput(f.input, 0, 6);
    expect([f.view.state.selection.main.from, f.view.state.selection.main.to]).toEqual([0, 9]);
  });

  it("types next to a mention, deletes it whole and restores the text with undo", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 4, 4);
    await userEvent.keyboard("Hi ");
    expect(f.raw()).toBe("Ask Hi @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 7, end: 12 }]);
    selectComposerInput(f.input, 12, 12);
    await userEvent.keyboard("!");
    expect(f.raw()).toBe("Ask Hi @Alex! after");
    expect(f.mentions()).toHaveLength(1);
    // A letter typed against the chip gets the protocol's required separator.
    selectComposerInput(f.input, 12, 12);
    await userEvent.keyboard("s");
    expect(f.raw()).toBe("Ask Hi @Alex s! after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 7, end: 12 }]);
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(f.raw()).toBe("Ask Hi @Alex! after");
    selectComposerInput(f.input, 12, 12);
    await userEvent.keyboard("{Backspace}");
    expect(f.raw()).toBe("Ask Hi ! after");
    expect(f.mentions()).toEqual([]);
    expect(f.surface.querySelectorAll(".chat-composer-mention")).toHaveLength(0);
    await userEvent.keyboard(`{${historyModifier}>}z{/${historyModifier}}`);
    expect(f.raw()).toBe("Ask Hi @Alex! after");
    // Undo restores the chip's recipient, not just its text.
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 7, end: 12 }]);
    await expect.poll(() => f.surface.querySelectorAll(".chat-composer-mention").length).toBe(1);
    await userEvent.keyboard(`{${historyModifier}>}{Shift>}Z{/Shift}{/${historyModifier}}`);
    expect(f.raw()).toBe("Ask Hi ! after");
    expect(f.inputEvents.at(-1)?.inputType).toBe("historyRedo");
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
    // A chip cut from this editor carries its recipient back on paste.
    expect(JSON.parse(cut.getData("application/x-openclaw-mentions"))).toEqual([
      { profileId: "alex-one", start: 0, end: 5 },
    ]);
    selectComposerInput(f.input, 4, 9);
    f.content.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: cut }),
    );
    expect(f.raw()).toBe("Ask @Alex after");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 4, end: 9 }]);
    await expect.poll(() => f.surface.querySelectorAll(".chat-composer-mention").length).toBe(1);
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
    const selection = window.getSelection()!;
    const text = selection.anchorNode;
    if (!(text instanceof Text)) {
      throw new Error("Expected the composition caret in trailing text");
    }
    const offset = selection.anchorOffset;
    text.insertData(offset, "に");
    selection.collapse(text, offset + 1);
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
    expect(f.view.state.selection.main.head).toBe(16);
    expect(events).toEqual(["compositionstart", "compositionend"]);
    // A distinct send action, beyond Safari's 100ms IME-confirmation guard.
    const now = Date.now;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + 101);
    try {
      await userEvent.keyboard("{Enter}");
    } finally {
      clock.mockRestore();
    }
    expect(events).toEqual(["compositionstart", "compositionend", "send"]);
    expect(f.raw()).toBe("Ask @Alex afterに");
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 4, end: 9 }]);
    f.input.readOnly = true;
    syncComposerInput(f.input);
    await userEvent.keyboard("x");
    expect(f.raw()).toBe("Ask @Alex afterに");
    f.input.disabled = true;
    syncComposerInput(f.input);
    await expect.poll(() => f.content.getAttribute("contenteditable")).toBe("false");
    expect(composerInputHasFocus(f.input)).toBe(false);
  });

  it.each(["readOnly", "disabled"] as const)(
    "does not mutate on rich paste or composition while %s",
    async (lock) => {
      const f = fixture(kind);
      selectComposerInput(f.input, 9, 9);
      f.input[lock] = true;
      syncComposerInput(f.input);
      await expect.poll(() => f.view.state.readOnly).toBe(true);
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "@Bob");
      clipboard.setData(
        "application/x-openclaw-mentions",
        JSON.stringify([{ profileId: "bob", start: 0, end: 4 }]),
      );
      f.content.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
      expect(f.raw()).toBe("Ask @Alex after");
      f.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(f.raw()).toBe("Ask @Alex after");
      expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 4, end: 9 }]);
    },
  );

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

  it("deletes a mention whole with forward Delete and never edits inside it", async () => {
    const f = fixture(kind);
    focusComposerInput(f.input);
    selectComposerInput(f.input, 4, 4);
    await userEvent.keyboard("{Delete}");
    expect(f.raw()).toBe("Ask  after");
    expect(f.mentions()).toEqual([]);
    expect(f.view.state.selection.main.head).toBe(4);
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
    selectComposerInput(f.input, 0, 3);
    await layout();
    const probe = document.createElement("i");
    probe.style.backgroundColor = "var(--selection-bg)";
    f.surface.append(probe);
    const selected = () =>
      getComputedStyle(f.view.dom.querySelector(".cm-selectionBackground")!).backgroundColor;
    expect(selected()).toBe(getComputedStyle(probe).backgroundColor);
    f.content.blur();
    await layout();
    expect(selected()).toBe(getComputedStyle(probe).backgroundColor);
    f.surface.style.width = "1000px";
    await layout();
    await expect.poll(() => f.view.dom.getBoundingClientRect().height).toBeLessThan(before);
  });
});

it("wraps a name wider than the composer and keeps a short chip on the text line", async () => {
  const name = "@Alexandra Beatriz de Albuquerque Monteiro-Silva";
  const long = fixture("chat", name + " ", 230, [
    { profileId: "alex", start: 0, end: name.length },
  ]);
  await layout();
  const chip = long.content.querySelector<HTMLElement>(".chat-composer-mention")!;
  expect(chip.textContent).toBe(name);
  expect(chip.getBoundingClientRect().right).toBeLessThanOrEqual(
    long.content.getBoundingClientRect().right + 1,
  );
  expect(chip.getBoundingClientRect().height).toBeGreaterThan(30);
  expect(long.view.scrollDOM.scrollWidth).toBeLessThanOrEqual(long.view.scrollDOM.clientWidth + 1);
  const short = fixture("chat");
  await layout();
  const line = short.content.querySelector<HTMLElement>(".cm-line")!;
  const textBottom = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().bottom;
  };
  const inside = short.content.querySelector(".chat-composer-mention")!.lastChild!;
  expect(Math.abs(textBottom(inside) - textBottom(line.firstChild!))).toBeLessThan(1);
  expect(line.getBoundingClientRect().height).toBe(20);
});

it("does not seed undo with a native snapshot the selection did not replace", () => {
  const alex = [{ profileId: "alex-one", start: 0, end: 5 }];
  const mounted = (value: string) =>
    fixture("chat", "@Alex ", 230, alex, (input, mentions) =>
      mountMentionComposerEditor(input, mentions, undefined, {
        value,
        mentions: [],
        selection: { start: value.length, end: value.length, direction: "none" },
      }),
    );
  // The owner cleared a sent draft without an input event; undo must not restore it.
  const stale = mounted("already sent");
  expect(undo(stale.view)).toBe(false);
  expect(stale.raw()).toBe("@Alex ");
  const typed = mounted("@al");
  expect(undo(typed.view)).toBe(true);
  expect(typed.raw()).toBe("@al");
});

it("retains one mention theme across Chat and New editor lifetimes", async () => {
  const styles = () =>
    Array.from(document.head.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .filter((text) => text.includes(".chat-composer-mention"))
      .join("\n");
  fixture("chat");
  await layout();
  const initial = styles();
  expect(initial).toContain(".chat-composer-mention");
  cleanups.pop()!();
  for (const kind of ["new-session", "chat", "new-session"] as const) {
    const f = fixture(kind);
    await layout();
    const chip = f.content.querySelector<HTMLElement>(".chat-composer-mention")!;
    const avatar = chip.querySelector<HTMLElement>(".markdown-person-reference__avatar")!;
    expect(getComputedStyle(chip).display).toBe("inline-block");
    expect(getComputedStyle(avatar).userSelect).toBe("text");
    expect(styles()).toBe(initial);
    cleanups.pop()!();
  }
});

it("reuses unchanged readonly effects and combines attribute changes without mutation", async () => {
  const iterate = vi.fn(() => [][Symbol.iterator]());
  let effects: readonly StateEffect<unknown>[] = Object.freeze(
    Object.assign([], { [Symbol.iterator]: iterate }),
  );
  const marker = StateEffect.define<string>();
  const received: string[] = [];
  const f = fixture("chat", "Hello", 230, [], (input) =>
    mountComposerEditor(input, {
      extensions: EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) {
          for (const effect of transaction.effects) {
            if (effect.is(marker)) {
              received.push(effect.value);
            }
          }
        }
      }),
      sync: () => effects,
    }),
  );
  iterate.mockClear();
  syncComposerInput(f.input);
  await Promise.resolve();
  syncComposerInput(f.input);
  await Promise.resolve();
  expect(iterate).not.toHaveBeenCalled();
  effects = Object.freeze([marker.of("first"), marker.of("second")]);
  f.input.value = "Changed";
  f.input.setAttribute("aria-label", "Updated message");
  syncComposerInput(f.input);
  await Promise.resolve();
  expect(f.view.state.doc.toString()).toBe("Changed");
  expect(f.content.getAttribute("aria-label")).toBe("Updated message");
  expect(received).toEqual(["first", "second"]);
  expect(effects.map((effect) => effect.value)).toEqual(["first", "second"]);
});

it("hosts an ordinary non-atomic decoration without the mention feature", async () => {
  const f = fixture("chat", "Hello world", 230, [], (input) =>
    mountComposerEditor(input, {
      extensions: EditorView.decorations.of(
        Decoration.set([Decoration.mark({ class: "test-inline-highlight" }).range(0, 5)]),
      ),
    }),
  );
  expect(f.surface.querySelector(".test-inline-highlight")?.textContent).toBe("Hello");
  expect(f.surface.querySelector(".chat-composer-mention")).toBeNull();
  focusComposerInput(f.input);
  selectComposerInput(f.input, 2, 2);
  await userEvent.keyboard("!");
  expect(f.raw()).toBe("He!llo world");
  expect(undo(f.view)).toBe(true);
  expect(f.raw()).toBe("Hello world");
});
