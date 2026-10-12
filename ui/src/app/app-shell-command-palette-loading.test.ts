/* @vitest-environment jsdom */

import { render, nothing } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "../components/modal-dialog.ts";
import {
  CommandPaletteLoadingState,
  renderCommandPaletteLoading,
} from "./app-shell-command-palette-loading.ts";

let restoreDialog: () => void;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  restoreDialog = installDialogPolyfill();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  document.body.replaceChildren();
  restoreDialog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mountLoader() {
  const foreground = document.createElement("textarea");
  foreground.value = "Keep this foreground draft";
  document.body.prepend(foreground);
  foreground.focus();
  foreground.setSelectionRange(5, 9, "backward");
  const state = new CommandPaletteLoadingState({ requestUpdate: vi.fn() });
  state.begin();
  const close = vi.fn(() => state.clear());
  render(renderCommandPaletteLoading(state, close), container);
  const input = container.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  input.focus();
  return { state, input, foreground, close };
}

function type(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("cold command palette input custody", () => {
  it.each(["typed", "pasted", "replaced", "dropped", "composing"])(
    "preserves only a typed mention trigger: %s",
    (mode) => {
      const { state, input } = mountLoader();
      const edit = (value: string, inputType: string, data: string) => {
        input.value = value;
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType,
            data,
            isComposing: mode === "composing",
          }),
        );
      };
      edit("Ask @", mode === "pasted" ? "insertFromPaste" : "insertText", "Ask @");
      edit("Ask @Al", "insertText", "Al");
      if (mode === "replaced") {
        edit("Ask @Alex", "insertFromPaste", "@Alex");
      }
      if (mode === "dropped") {
        edit("Ask @Alex", "insertFromDrop", "ex");
      }
      expect(state.captureHandoff()()?.mentionTrigger).toBe(mode === "typed" ? 4 : undefined);
      state.begin();
      expect(state.captureHandoff()()?.mentionTrigger).toBeUndefined();
    },
  );

  it.each(["transfer", "dismiss"] as const)("keeps pasted images only until %s", (outcome) => {
    const { state, input } = mountLoader();
    const file = new File(["image"], "clipboard.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ type: file.type, getAsFile: () => file }], getData: () => "" },
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const take = state.captureHandoff();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(state.submitRequested).toBe(true);
    if (outcome === "dismiss") {
      state.clear();
      state.begin();
      expect(take()).toBeUndefined();
      expect(state.captureHandoff()()?.imageFiles).toBeUndefined();
    } else {
      expect(take()).toMatchObject({ value: "", imageFiles: [file], submitRequested: true });
      expect(take()).toBeUndefined();
    }
  });

  it.each([
    { modifier: { ctrlKey: true }, submit: true, value: "Start this background task" },
    { modifier: { metaKey: true }, submit: true, value: "Start this background task" },
    { modifier: {}, submit: false, value: "unsent prompt" },
  ])(
    "handles Enter without leaking a loading prompt ($modifier)",
    ({ modifier, submit, value }) => {
      const { state, input, close } = mountLoader();
      type(input, value);
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        ...modifier,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ...modifier,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(event.defaultPrevented).toBe(true);
      if (!submit) {
        expect(close).not.toHaveBeenCalled();
        expect(state.value).toBe("unsent prompt");
        const newline = new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(newline);
        expect(newline.defaultPrevented).toBe(false);
        expect(state.submitRequested).toBe(false);
        return;
      }
      const take = state.captureHandoff();
      expect(take()).toMatchObject({ value, submitRequested: true });
      expect(take()).toBeUndefined();
      state.begin();
      expect(state.captureHandoff()()?.submitRequested).not.toBe(true);
    },
  );

  it.each([
    { remount: false, value: "early draft continued", start: 6, end: 11 },
    { remount: true, value: "retain this selection", start: 3, end: 10 },
  ])(
    "hands off live text, selection and original focus (remounted: $remount)",
    ({ remount, value, start, end }) => {
      const { state, input, foreground, close } = mountLoader();
      expect(input.disabled).toBe(false);
      type(input, remount ? value : "early draft");
      const take = state.captureHandoff();
      type(input, value);
      input.setSelectionRange(start, end, "backward");
      if (remount) {
        render(nothing, container);
        render(renderCommandPaletteLoading(state, close), container);
        const replacement = container.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
        expect(replacement).not.toBe(input);
        expect(replacement.value).toBe(value);
        expect([
          replacement.selectionStart,
          replacement.selectionEnd,
          replacement.selectionDirection,
        ]).toEqual([start, end, "backward"]);
      }
      expect(take()).toEqual({
        value,
        selectionStart: start,
        selectionEnd: end,
        selectionDirection: "backward",
        returnFocus: foreground,
      });
      expect(foreground.value).toBe("Keep this foreground draft");
      expect([foreground.selectionStart, foreground.selectionEnd]).toEqual([5, 9]);
      expect(state.active).toBe(false);
      expect(take()).toBeUndefined();
    },
  );

  it("keeps the composing field alive until its final input and selection commit", async () => {
    const { state, input } = mountLoader();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(input, "に");
    const accepted = vi.fn();
    const take = state.captureHandoff();
    state.handoff(() => accepted(take()));
    expect(accepted).not.toHaveBeenCalled();
    expect(state.waitingForComposition).toBe(true);
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
    // Some engines emit the final input after compositionend.
    type(input, "日本");
    input.setSelectionRange(1, 2, "backward");
    expect(accepted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "日本",
        selectionStart: 1,
        selectionEnd: 2,
        selectionDirection: "backward",
      }),
    );
  });

  it.each(["composing", "commit-pending"] as const)(
    "retires a %s handoff without reviving its prompt on reopen",
    async (phase) => {
      const { state, input } = mountLoader();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      type(input, "retired text");
      const accepted = vi.fn();
      state.handoff(accepted);
      const take = state.captureHandoff();
      if (phase === "commit-pending") {
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      }
      state.clear();
      // A late ref/input from the old render cannot resurrect custody.
      state.inputRef(undefined);
      state.captureInput();
      state.begin();
      expect(take()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
      expect(accepted).not.toHaveBeenCalled();
      expect(state.value).toBe("");
    },
  );
});
