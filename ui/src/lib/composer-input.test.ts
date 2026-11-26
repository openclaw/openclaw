// @vitest-environment jsdom
import { redo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { mountMentionComposerEditor } from "../pages/chat/components/composer-editor-mentions.tsx";
import type { HumanMention } from "./chat/chat-types.ts";
import { updateHumanMentions } from "./chat/human-mentions.ts";
import {
  readComposerEditor,
  replaceComposerInputWithHistory,
  selectComposerInput,
} from "./composer-input.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function field() {
  const input = document.createElement("textarea");
  input.value = "original draft";
  document.body.append(input);
  const command = vi.fn((_command: string, _showUi: boolean, _text: string) => true);
  Object.defineProperty(document, "queryCommandSupported", {
    configurable: true,
    value: () => true,
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  return { input, command };
}

function mentionEditor(
  initial = "@Alex old @Alex tail @Alex.",
  originalMentions: readonly HumanMention[] = [
    { profileId: "first-person", start: 0, end: 5, access: "read" },
    { profileId: "selected-person", start: 10, end: 15, access: "suggest" },
    { profileId: "last-person", start: 21, end: 26, access: "send" },
  ],
) {
  const surface = document.createElement("div");
  const input = document.createElement("textarea");
  input.value = initial;
  surface.append(input);
  document.body.append(surface);
  let value = initial;
  let mentions = originalMentions;
  let events = 0;
  const publish = () => {
    mentions = updateHumanMentions(value, input.value, mentions);
    value = input.value;
    events += 1;
  };
  input.addEventListener("input", publish);
  const mounted = mountMentionComposerEditor(input, () => mentions);
  onTestFinished(() => {
    mounted.destroy();
    input.removeEventListener("input", publish);
    surface.remove();
  });
  const bridge = expectDefined(readComposerEditor(input), "expected a registered mention editor");
  return {
    input,
    bridge,
    view: expectDefined(EditorView.findFromDOM(bridge.element), "expected the CodeMirror view"),
    initial,
    originalMentions,
    value: () => value,
    mentions: () => mentions,
    events: () => events,
    setMentions: (next: readonly HumanMention[]) => {
      mentions = next;
      mounted.sync();
    },
  };
}

describe("reviewed composer history transaction", () => {
  it.each([
    { next: "@Alex dictated words tail @Alex.", lastStart: 26 },
    { next: "@Alex old @Alex tail @Alex.", lastStart: 21 },
  ])("retains recipients outside a reviewed partial replacement: $next", ({ next, lastStart }) => {
    const f = mentionEditor();
    const range = { start: 6, end: 15 };
    selectComposerInput(f.input, range.start, range.end);
    expect(replaceComposerInputWithHistory(f.input, next, () => true, range)).toBe(true);
    const retained = [
      { profileId: "first-person", start: 0, end: 5, access: "read" },
      { profileId: "last-person", start: lastStart, end: lastStart + 5, access: "send" },
    ];
    expect(f.value()).toBe(next);
    expect(f.mentions()).toEqual(retained);
    expect(f.events()).toBe(1);

    f.bridge.undo();
    expect(f.value()).toBe(f.initial);
    expect(f.mentions()).toEqual(f.originalMentions);
    expect(redo(f.view)).toBe(true);
    expect(f.value()).toBe(next);
    expect(f.mentions()).toEqual(retained);
  });

  it("keeps every untouched recipient around a reviewed caret insertion", () => {
    const f = mentionEditor();
    const range = { start: 6, end: 6 };
    const next = "@Alex dictated old @Alex tail @Alex.";
    const retained = [
      { profileId: "first-person", start: 0, end: 5, access: "read" },
      { profileId: "selected-person", start: 19, end: 24, access: "suggest" },
      { profileId: "last-person", start: 30, end: 35, access: "send" },
    ];
    selectComposerInput(f.input, range.start, range.end);
    expect(replaceComposerInputWithHistory(f.input, next, () => true, range)).toBe(true);
    expect(f.value()).toBe(next);
    expect(f.mentions()).toEqual(retained);
    expect(f.events()).toBe(1);

    f.bridge.undo();
    expect(f.value()).toBe(f.initial);
    expect(f.mentions()).toEqual(f.originalMentions);
    expect(redo(f.view)).toBe(true);
    expect(f.value()).toBe(next);
    expect(f.mentions()).toEqual(retained);
  });

  const accessModes: NonNullable<HumanMention["access"]>[] = ["read", "suggest", "send"];
  it.each(accessModes)(
    "retains updated %s access without making metadata sync a separate Undo step",
    (access) => {
      const f = mentionEditor("@Alex old", [{ profileId: "alex", start: 0, end: 5 }]);
      const current = [{ profileId: "alex", start: 0, end: 5, access }];
      f.setMentions(current);
      expect(f.events()).toBe(0);

      const range = { start: 6, end: 9 };
      selectComposerInput(f.input, range.start, range.end);
      expect(replaceComposerInputWithHistory(f.input, "@Alex dictated", () => true, range)).toBe(
        true,
      );
      expect(f.value()).toBe("@Alex dictated");
      expect(f.mentions()).toEqual(current);
      expect(f.events()).toBe(1);

      f.bridge.undo();
      expect(f.value()).toBe("@Alex old");
      expect(f.mentions()).toEqual(current);
      f.bridge.undo();
      expect(f.value()).toBe("@Alex old");
      expect(f.mentions()).toEqual(current);
      expect(redo(f.view)).toBe(true);
      expect(f.value()).toBe("@Alex dictated");
      expect(f.mentions()).toEqual(current);
    },
  );

  it.each([
    { next: "Ask @Alexhello", range: { start: 9, end: 9 } },
    { next: "Ask@Alex", range: { start: 3, end: 4 } },
  ])("undoes an adjacent recipient invalidation with its text: $next", ({ next, range }) => {
    const f = mentionEditor("Ask @Alex", [
      { profileId: "alex", start: 4, end: 9, access: "suggest" },
    ]);
    selectComposerInput(f.input, range.start, range.end);
    expect(replaceComposerInputWithHistory(f.input, next, () => true, range)).toBe(true);
    expect(f.value()).toBe(next);
    expect(f.mentions()).toEqual([]);
    expect(f.events()).toBe(1);

    f.bridge.undo();
    expect(f.value()).toBe("Ask @Alex");
    expect(f.mentions()).toEqual([{ profileId: "alex", start: 4, end: 9, access: "suggest" }]);
    expect(redo(f.view)).toBe(true);
    expect(f.value()).toBe(next);
    expect(f.mentions()).toEqual([]);
  });

  it("keeps whole-draft proposals as complete replacements with recipient-aware undo", () => {
    const f = mentionEditor();
    f.bridge.replaceAll(f.initial);
    expect(f.value()).toBe(f.initial);
    expect(f.mentions()).toEqual([]);
    f.bridge.undo();
    expect(f.value()).toBe(f.initial);
    expect(f.mentions()).toEqual(f.originalMentions);
    expect(redo(f.view)).toBe(true);
    expect(f.value()).toBe(f.initial);
    expect(f.mentions()).toEqual([]);
  });

  it("revalidates after focus handlers change the draft or revoke the request", () => {
    const { input, command } = field();
    let current = true;
    input.addEventListener("focus", () => {
      input.value = "newer user draft";
      current = false;
    });
    expect(
      replaceComposerInputWithHistory(input, "stale replacement", () => current, {
        start: 0,
        end: input.value.length,
      }),
    ).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(input.value).toBe("newer user draft");
  });

  it.each([true, false])(
    "reports the single native attempt without retrying when API success is %s",
    (reported) => {
      const { input, command } = field();
      command.mockImplementation((_command, _showUi, text) => {
        input.value =
          input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
        return reported;
      });
      const rawReplacement = vi.spyOn(input, "setRangeText");
      expect(
        replaceComposerInputWithHistory(input, "original reviewed text", () => true, {
          start: 9,
          end: 14,
        }),
      ).toBe(reported ? true : undefined);
      expect(command).toHaveBeenCalledExactlyOnceWith("insertText", false, "reviewed text");
      expect(rawReplacement).not.toHaveBeenCalled();
      expect(input.value).toBe("original reviewed text");
    },
  );

  it("keeps original text when no qualified history command exists", () => {
    const { input, command } = field();
    Object.defineProperty(document, "queryCommandSupported", {
      configurable: true,
      value: () => false,
    });
    expect(
      replaceComposerInputWithHistory(input, "replacement", () => true, {
        start: 0,
        end: input.value.length,
      }),
    ).toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(input.value).toBe("original draft");
  });
});
