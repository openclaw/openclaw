import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import "../../styles/chat/composer-surface.css";
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

function fixture(
  kind: "chat" | "new-session",
  text = "Ask @Alex after",
  width = 230,
  selected?: readonly HumanMention[],
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
  it.each(["'", "’"])(
    "attaches a typed %s possessive without losing the chip or undo",
    async (quote) => {
      const f = fixture(kind, "@Alex ", 230, [{ profileId: "alex-one", start: 0, end: 5 }]);
      focusComposerInput(f.input);
      selectComposerInput(f.input, 6, 6);
      await userEvent.keyboard(quote + "s");
      expect(f.raw()).toBe("@Alex" + quote + "s");
      expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 0, end: 5 }]);
      expect(undo(f.view)).toBe(true);
      expect(f.raw()).toBe("@Alex ");
      expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 0, end: 5 }]);
      expect(redo(f.view)).toBe(true);
      expect(f.raw()).toBe("@Alex" + quote + "s");
      selectComposerInput(f.input, 0, 0);
      await userEvent.keyboard(quote);
      expect(f.raw()).toBe(quote + "@Alex" + quote + "s");
      expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 1, end: 6 }]);
    },
  );

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
    await userEvent.keyboard("{Control>}z{/Control}");
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
    await userEvent.keyboard("{Control>}z{/Control}");
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
      await userEvent.keyboard("{Control>}z{/Control}");
      expect(f.raw()).toBe("@Alex @Alex");
      expect(f.mentions()).toEqual([
        { profileId: "alex-one", start: 0, end: 5 },
        { profileId: "alex-two", start: 6, end: 11 },
      ]);
      await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
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
    expect(f.surface.querySelectorAll(".chat-composer-mention-layer")).toHaveLength(0);
    expect(f.view.coordsAtPos(4)!.right).toBeCloseTo(chip.getBoundingClientRect().left, 0);
    expect(f.view.coordsAtPos(9)!.left).toBeCloseTo(chip.getBoundingClientRect().right, 0);
    f.surface.style.width = "70px";
    await layout();
    const after = f.view.coordsAtPos(f.view.state.doc.length)!;
    expect(after.bottom).toBeGreaterThan(f.view.coordsAtPos(0)!.bottom);
    expect(after.right).toBeLessThanOrEqual(f.content.getBoundingClientRect().right + 1);
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
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(f.raw()).toBe("Ask Hi @Alex! after");
    // Undo restores the chip's recipient, not just its text.
    expect(f.mentions()).toEqual([{ profileId: "alex-one", start: 7, end: 12 }]);
    await expect.poll(() => f.surface.querySelectorAll(".chat-composer-mention").length).toBe(1);
    await userEvent.keyboard("{Control>}y{/Control}");
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
    f.surface.style.width = "1000px";
    await layout();
    await expect.poll(() => f.view.dom.getBoundingClientRect().height).toBeLessThan(before);
  });
});
