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
  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "transfers one explicit cold submit intent: %j",
    (modifier) => {
      const { state, input } = mountLoader();
      type(input, "Start this background task");
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
      const take = state.captureHandoff();
      expect(take()).toMatchObject({ value: "Start this background task", submitRequested: true });
      expect(take()).toBeUndefined();
      state.begin();
      expect(state.captureHandoff()()?.submitRequested).not.toBe(true);
    },
  );

  it("accepts early input and transfers the latest selection with the original focus target", () => {
    const { state, input, foreground } = mountLoader();
    expect(input.disabled).toBe(false);
    type(input, "early draft");
    const take = state.captureHandoff();
    // Input after module readiness still belongs to the live field until focus handoff.
    type(input, "early draft continued");
    input.setSelectionRange(6, 11, "backward");
    const snapshot = take();
    expect(snapshot).toEqual({
      value: "early draft continued",
      selectionStart: 6,
      selectionEnd: 11,
      selectionDirection: "backward",
      returnFocus: foreground,
    });
    expect(foreground.value).toBe("Keep this foreground draft");
    expect([foreground.selectionStart, foreground.selectionEnd]).toEqual([5, 9]);
    expect(state.active).toBe(false);
    expect(take()).toBeUndefined();
  });

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

  it("restores a remounted loader's selection after binding its retained value", () => {
    const { state, input, close } = mountLoader();
    type(input, "retain this selection");
    input.setSelectionRange(3, 10, "backward");
    render(nothing, container);
    render(renderCommandPaletteLoading(state, close), container);
    const replacement = container.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
    expect(replacement).not.toBe(input);
    expect(replacement.value).toBe("retain this selection");
    expect([
      replacement.selectionStart,
      replacement.selectionEnd,
      replacement.selectionDirection,
    ]).toEqual([3, 10, "backward"]);
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

  it("does not submit, navigate, or insert a newline on plain Enter while loading", () => {
    const { state, input, close } = mountLoader();
    type(input, "unsent prompt");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
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
  });
});
