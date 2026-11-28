import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";
import "../../test-helpers/load-styles.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  focusComposerInput,
  selectComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import { mountMentionComposerEditor } from "./components/composer-editor-mentions.tsx";

function editor(text: string, initial: readonly HumanMention[]) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "width:600px; margin:20px; font:16px/24px Arial";
  const input = document.createElement("textarea");
  input.value = text;
  let previous = text;
  let mentions = initial;
  const inputTypes: string[] = [];
  input.addEventListener("input", (event) => {
    inputTypes.push((event as InputEvent).inputType);
    mentions = updateHumanMentions(previous, input.value, mentions);
    previous = input.value;
    queueMicrotask(() => syncComposerInput(input));
  });
  wrapper.append(input);
  document.body.append(wrapper);
  const mounted = mountMentionComposerEditor(input, () => mentions);
  onTestFinished(() => {
    mounted.destroy();
    wrapper.remove();
  });
  const content = wrapper.querySelector<HTMLElement>('[data-composer-editor="true"]')!;
  const view = EditorView.findFromDOM(content)!;
  return { input, content, view, mentions: () => mentions, inputTypes };
}

function drag(
  source: ReturnType<typeof editor>,
  target = source,
  copy = false,
  position = target.view.state.doc.length,
) {
  focusComposerInput(source.input);
  selectComposerInput(source.input, 0, 5);
  // Exercise CodeMirror's browser drag handlers with real DataTransfer state.
  // Synthetic DragEvents do not claim trusted OS pointer-gesture coverage.
  const dataTransfer = new DataTransfer();
  const options = { bubbles: true, cancelable: true, dataTransfer, ctrlKey: copy, altKey: copy };
  source.content.dispatchEvent(new DragEvent("dragstart", options));
  const end = target.view.coordsAtPos(position)!;
  target.content.dispatchEvent(
    new DragEvent("drop", {
      ...options,
      clientX: end.left + 1,
      clientY: (end.top + end.bottom) / 2,
    }),
  );
  source.content.dispatchEvent(new DragEvent("dragend", options));
}

const initial = [
  { profileId: "alex-one", start: 0, end: 5 },
  { profileId: "alex-two", start: 8, end: 13 },
];

it.each([false, true])(
  "preserves same-text recipients through browser mention drag handlers (copy=%s)",
  (copy) => {
    const f = editor("@Alex + @Alex done ", initial);
    drag(f, f, copy);
    expect(f.input.value).toBe(copy ? "@Alex + @Alex done @Alex" : " + @Alex done @Alex");
    // Owners treat a move like any drop, never as typed text containing "@".
    expect(f.inputTypes).toEqual(["insertFromDrop"]);
    const moved = copy
      ? [...initial, { profileId: "alex-one", start: 19, end: 24 }]
      : [
          { profileId: "alex-two", start: 3, end: 8 },
          { profileId: "alex-one", start: 14, end: 19 },
        ];
    expect(f.mentions()).toEqual(moved);
    expect(undo(f.view)).toBe(true);
    expect(f.input.value).toBe("@Alex + @Alex done ");
    expect(f.mentions()).toEqual(initial);
    expect(redo(f.view)).toBe(true);
    expect(f.mentions()).toEqual(moved);
  },
);

it("carries recipient metadata to another rich composer without moving the source", () => {
  const source = editor("@Alex + @Alex done ", initial);
  const target = editor("To @Alex then ", [{ profileId: "alex-three", start: 3, end: 8 }]);
  drag(source, target);
  expect(source.mentions()).toEqual(initial);
  expect(source.input.value).toBe("@Alex + @Alex done ");
  expect(target.input.value).toBe("To @Alex then @Alex");
  expect(target.mentions()).toEqual([
    { profileId: "alex-three", start: 3, end: 8 },
    { profileId: "alex-one", start: 14, end: 19 },
  ]);
  expect(undo(target.view)).toBe(true);
  expect(target.mentions()).toEqual([{ profileId: "alex-three", start: 3, end: 8 }]);
  expect(redo(target.view)).toBe(true);
  expect(target.mentions().map((mention) => mention.profileId)).toEqual(["alex-three", "alex-one"]);
});

it("drags the grabbed selection when a fast first pointer move precedes dragstart", () => {
  const f = editor("@Alex + @Alex done ", initial);
  focusComposerInput(f.input);
  selectComposerInput(f.input, 0, 7);
  const grab = f.view.coordsAtPos(6)!;
  const pointer = { bubbles: true, cancelable: true, clientY: (grab.top + grab.bottom) / 2 };
  // WebKit's order for a quick drag: mousedown, a mousemove past CodeMirror's
  // selection threshold, and only then dragstart.
  f.content.dispatchEvent(
    new MouseEvent("mousedown", { ...pointer, clientX: grab.left + 1, detail: 1 }),
  );
  document.dispatchEvent(
    new MouseEvent("mousemove", { ...pointer, clientX: grab.left + 60, buttons: 1 }),
  );
  expect(f.view.state.selection.main.from).toBe(6);
  const dataTransfer = new DataTransfer();
  f.content.dispatchEvent(new DragEvent("dragstart", { ...pointer, dataTransfer }));
  const end = f.view.coordsAtPos(f.view.state.doc.length)!;
  f.content.dispatchEvent(
    new DragEvent("drop", { ...pointer, dataTransfer, clientX: end.left + 1 }),
  );
  document.dispatchEvent(new MouseEvent("mouseup", pointer));
  expect(f.input.value).toBe(" @Alex done @Alex +");
  expect(f.mentions()).toEqual([
    { profileId: "alex-two", start: 1, end: 6 },
    { profileId: "alex-one", start: 12, end: 17 },
  ]);
});

it("forgets a grabbed selection once the press ends without a drag", () => {
  const f = editor("@Alex + @Alex done ", initial);
  focusComposerInput(f.input);
  selectComposerInput(f.input, 0, 7);
  const grab = f.view.coordsAtPos(6)!;
  const pointer = { bubbles: true, cancelable: true, clientY: (grab.top + grab.bottom) / 2 };
  f.content.dispatchEvent(
    new MouseEvent("mousedown", { ...pointer, clientX: grab.left + 1, detail: 1 }),
  );
  document.dispatchEvent(new MouseEvent("mouseup", pointer));
  // A touch drag has no mousedown of its own; it must move the current selection.
  selectComposerInput(f.input, 8, 13);
  const dataTransfer = new DataTransfer();
  f.content.dispatchEvent(new DragEvent("dragstart", { ...pointer, dataTransfer }));
  expect(dataTransfer.getData("text/plain")).toBe("@Alex");
  expect(f.view.state.selection.main.from).toBe(8);
});

it("moves focus one stop when Tab leaves the rich editor", async () => {
  const f = editor("@Alex ", [{ profileId: "alex-one", start: 0, end: 5 }]);
  const stops = [document.createElement("button"), document.createElement("button")];
  f.input.parentElement!.append(...stops);
  focusComposerInput(f.input);
  // WebKit ran a second default Tab for the copy forwarded to the hidden port.
  await userEvent.tab();
  expect(document.activeElement).toBe(stops[0]);
});

it("keeps an internal drop onto its own selection unchanged", () => {
  const f = editor("@Alex + @Alex done ", initial);
  drag(f, f, false, 5);
  expect(f.input.value).toBe("@Alex + @Alex done ");
  expect(f.mentions()).toEqual(initial);
});

it("preserves recipient boundaries when dropping beside ordinary text", () => {
  const source = editor("@Alex ", [{ profileId: "alex-one", start: 0, end: 5 }]);
  const target = editor("Tail @Alex endword", [{ profileId: "alex-two", start: 5, end: 10 }]);
  drag(source, target);
  expect(target.input.value).toBe("Tail @Alex endword @Alex");
  expect(target.mentions()).toEqual([
    { profileId: "alex-two", start: 5, end: 10 },
    { profileId: "alex-one", start: 19, end: 24 },
  ]);
});
