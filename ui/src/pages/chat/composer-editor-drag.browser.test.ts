import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expect, it, onTestFinished } from "vitest";
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
  input.addEventListener("input", () => {
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
  return { input, content, view, mentions: () => mentions };
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
