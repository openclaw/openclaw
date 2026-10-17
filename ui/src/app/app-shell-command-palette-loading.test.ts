/* @vitest-environment jsdom */

import { createComponent, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { CommandPaletteElement } from "../components/command-palette-contract.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../components/modal-dialog.ts";
import { CommandPaletteLoading } from "./app-shell-command-palette-loading-view.tsx";
import {
  ShellCommandPaletteOwner,
  type CommandPaletteLoadingState,
} from "./app-shell-command-palette-loading.ts";
import { COMMAND_PALETTE_ELEMENT, createLazyCustomElementRequests } from "./lazy-custom-element.ts";

let restoreDialog: () => void;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  restoreDialog = installDialogPolyfill();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  restoreDialog();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createOwner(
  elements: ConstructorParameters<typeof ShellCommandPaletteOwner>[0]["elements"] = {},
  request: ConstructorParameters<typeof ShellCommandPaletteOwner>[1]["request"] = () => {},
) {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    return {
      dispose,
      owner: new ShellCommandPaletteOwner(
        {
          elements,
          commandPaletteElement: COMMAND_PALETTE_ELEMENT,
          lazyCustomElements: createLazyCustomElementRequests(),
          chatNavigationOptions: () => undefined,
          navigate: () => {},
        },
        { request, clear: () => {}, cancel: () => {}, pending: () => false },
      ),
    };
  });
}

function renderLoader(state: CommandPaletteLoadingState, onClose = () => {}) {
  mountSolid(() => createComponent(CommandPaletteLoading, { state, onClose }), { container });
  flush();
  return container.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
}

function keydown(input: HTMLTextAreaElement, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  input.dispatchEvent(event);
  return event;
}

function composition(input: HTMLTextAreaElement, phase: "start" | "end", data = "") {
  input.dispatchEvent(new CompositionEvent(`composition${phase}`, { bubbles: true, data }));
}

function mountLoader() {
  const foreground = document.createElement("textarea");
  foreground.value = "Keep this foreground draft";
  document.body.prepend(foreground);
  foreground.focus();
  foreground.setSelectionRange(5, 9, "backward");
  const { owner, dispose: disposeOwner } = createOwner();
  const state = owner.loading;
  state.begin();
  const close = vi.fn(() => state.clear());
  const input = renderLoader(state, close);
  input.focus();
  return { state, input, foreground, close, disposeOwner };
}

const selection = (start: number, end: number) => ({
  selectionStart: start,
  selectionEnd: end,
  selectionDirection: "backward",
});

function type(input: HTMLTextAreaElement, value: string, options?: InputEventInit) {
  input.value = value;
  if (options) {
    input.setSelectionRange(value.length, value.length);
  }
  const Input = options ? InputEvent : Event;
  input.dispatchEvent(new Input("input", { bubbles: true, ...options }));
}

describe("cold command palette input custody", () => {
  it.each(["open", "toggle"] as const)(
    "preserves the %s intent when the retained palette is detached",
    (action) => {
      const palette = () =>
        Object.assign(document.createElement("openclaw-command-palette"), {
          custodianAvailable: false,
          desktopAvailable: false,
          isOpen: false,
          openPalette: vi.fn<CommandPaletteElement["openPalette"]>(),
          togglePalette: vi.fn<CommandPaletteElement["togglePalette"]>(),
        });
      const detached = palette();
      container.append(detached);
      detached.remove();
      const elements = { commandPalette: detached };
      const request = vi.fn<ConstructorParameters<typeof ShellCommandPaletteOwner>[1]["request"]>();
      const { owner } = createOwner(elements, request);
      renderLoader(owner.loading);

      owner[action]();
      flush();
      expect(detached.openPalette).not.toHaveBeenCalled();
      expect(detached.togglePalette).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
      const input = container.querySelector<HTMLTextAreaElement>(".cmd-palette__input");
      if (!input) {
        throw new Error("Expected the replacement palette's loading input");
      }
      type(input, "Keep the replacement intent");

      const replacement = palette();
      container.append(replacement);
      elements.commandPalette = replacement;
      request.mock.calls[0]?.[2]?.();
      expect(replacement.openPalette).toHaveBeenCalledOnce();
      const take = replacement.openPalette.mock.calls[0]?.[0];
      expect(typeof take).toBe("function");
      expect(typeof take === "function" ? take() : undefined).toMatchObject({
        value: "Keep the replacement intent",
      });
      expect(owner.loading.active()).toBe(false);
    },
  );

  it.each(["typed", "pasted", "replaced", "dropped", "composing"])(
    "preserves only a typed mention trigger: %s",
    (mode) => {
      const { state, input } = mountLoader();
      const edit = (value: string, inputType: string, data: string) => {
        type(input, value, { inputType, data, isComposing: mode === "composing" });
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

  it("drops pasted images when dismissed before handoff", () => {
    const { state, input } = mountLoader();
    const file = new File(["image"], "clipboard.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ type: file.type, getAsFile: () => file }], getData: () => "" },
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const take = state.captureHandoff();
    keydown(input, { ctrlKey: true });
    expect(state.submitRequested()).toBe(true);
    state.clear();
    state.begin();
    expect(take()).toBeUndefined();
    expect(state.captureHandoff()()?.imageFiles).toBeUndefined();
  });

  it.each([
    { modifier: { ctrlKey: true }, submit: true, value: "Start this background task" },
    { modifier: { metaKey: true }, submit: true, value: "Start this background task" },
    { modifier: {}, submit: false, value: "unsent prompt" },
  ])("handles Enter without leaking its prompt ($modifier)", ({ modifier, submit, value }) => {
    const { state, input, close } = mountLoader();
    type(input, value);
    const event = keydown(input, modifier);
    keydown(input, { ...modifier, repeat: true });
    expect(event.defaultPrevented).toBe(true);
    if (!submit) {
      expect(close).not.toHaveBeenCalled();
      expect(state.value()).toBe("unsent prompt");
      const newline = keydown(input, { shiftKey: true });
      expect(newline.defaultPrevented).toBe(false);
      expect(state.submitRequested()).toBe(false);
      return;
    }
    flush();
    expect(state.submitRequested()).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(container.querySelector("textarea")).toBe(input);
    const take = state.captureHandoff();
    expect(take()).toMatchObject({ value, submitRequested: true });
    expect(take()).toBeUndefined();
    state.begin();
    expect(state.captureHandoff()()?.submitRequested).not.toBe(true);
  });

  it("hands off live text, selection and original focus across a remount", async () => {
    const value = "early draft continued";
    const [start, end] = [6, 11];
    const { state, input, foreground, close } = mountLoader();
    expect(input.disabled).toBe(false);
    type(input, "early draft");
    const take = state.captureHandoff();
    type(input, value);
    input.setSelectionRange(start, end, "backward");
    flush();
    expect(container.querySelector("textarea")).toBe(input);
    expect(input).toMatchObject(selection(start, end));
    cleanupSolid();
    const replacement = renderLoader(state, close);
    expect(replacement).not.toBe(input);
    expect(replacement.value).toBe(value);
    expect(replacement).toMatchObject(selection(start, end));
    // The removed Solid root cleans up after its replacement has mounted.
    await Promise.resolve();
    expect(take()).toEqual({
      value,
      ...selection(start, end),
      returnFocus: foreground,
    });
    expect(foreground.value).toBe("Keep this foreground draft");
    expect([foreground.selectionStart, foreground.selectionEnd]).toEqual([5, 9]);
    expect(state.active()).toBe(false);
    expect(take()).toBeUndefined();
  });

  it("keeps the composing field alive until its final input and selection commit", async () => {
    const { state, input } = mountLoader();
    composition(input, "start");
    type(input, "に");
    const accepted = vi.fn();
    const take = state.captureHandoff();
    state.handoff(() => accepted(take()));
    expect(accepted).not.toHaveBeenCalled();
    expect(state.waitingForComposition()).toBe(true);
    composition(input, "end", "日本");
    // Some engines emit the final input after compositionend.
    type(input, "日本");
    input.setSelectionRange(1, 2, "backward");
    expect(accepted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({ value: "日本", ...selection(1, 2) }),
    );
  });

  it.each(["disposed", "composing", "commit-pending"] as const)(
    "retires a %s handoff without reviving its prompt on reopen",
    async (phase) => {
      const { state, input, disposeOwner } = mountLoader();
      composition(input, "start");
      type(input, "retired text");
      const accepted = vi.fn();
      const beforeHandoff = phase === "disposed" ? state.captureHandoff() : undefined;
      state.handoff(accepted);
      const take = beforeHandoff ?? state.captureHandoff();
      if (phase !== "composing") {
        composition(input, "end");
      }
      if (phase === "disposed") {
        disposeOwner();
      } else {
        state.clear();
        // A late ref/input from the old render cannot resurrect custody.
        state.inputRef(undefined);
        state.captureInput();
        state.begin();
      }
      expect(take()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
      expect(accepted).not.toHaveBeenCalled();
      if (phase !== "disposed") {
        expect(state.value()).toBe("");
      }
    },
  );
});
