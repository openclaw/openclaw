/* @vitest-environment jsdom */

import { createComponent, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { CommandPaletteElement } from "../components/command-palette-contract.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../components/modal-dialog.tsx";
import { CommandPaletteLoading } from "./app-shell-command-palette-loading-view.tsx";
import { ShellCommandPaletteOwner } from "./app-shell-command-palette-loading.ts";

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

const emptyActions = { request: () => {}, clear: () => {}, cancel: () => {}, pending: () => false };
function loaderHost<T extends object>(elements: T) {
  return {
    elements,
    shellNavigation: { chatNavigationOptions: () => undefined, navigate: () => {} },
  };
}
function mountLoading(state: ShellCommandPaletteOwner["loading"], onClose: () => void) {
  return mountSolid(() => createComponent(CommandPaletteLoading, { state, onClose }), {
    container,
  });
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
function compose(input: HTMLTextAreaElement, end = false, data?: string) {
  input.dispatchEvent(
    new CompositionEvent(end ? "compositionend" : "compositionstart", { bubbles: true, data }),
  );
}

async function mountLoader() {
  const foreground = document.createElement("textarea");
  foreground.value = "Keep this foreground draft";
  document.body.prepend(foreground);
  foreground.focus();
  foreground.setSelectionRange(5, 9, "backward");
  const { state, dispose: disposeOwner } = createRoot((dispose) => {
    const loading = new ShellCommandPaletteOwner(loaderHost({}), emptyActions).loading;
    loading.begin();
    return { state: loading, dispose };
  });
  onTestFinished(disposeOwner);
  const close = vi.fn(() => state.clear());
  mountLoading(state, close);
  await vi.dynamicImportSettled();
  flush();
  await container.querySelector("openclaw-modal-dialog")!.updateComplete;
  const input = container.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  expect(document.activeElement).toBe(input);
  return { state, input, foreground, close, disposeOwner };
}

function type(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("cold command palette input custody", () => {
  it("never queues a mobile session submit while the palette loads", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    const { state, input } = await mountLoader();
    type(input, "Keep this mobile prompt");
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
      const event = keydown(input, modifiers);
      expect(event.defaultPrevented).toBe(false);
      expect(state.submitRequested()).toBe(false);
    }
    expect(state.captureHandoff()()).toMatchObject({ value: "Keep this mobile prompt" });
  });

  it.each(["open", "toggle"] as const)(
    "preserves the %s intent when the retained palette is detached",
    async (action) => {
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
      const host = loaderHost({ commandPalette: detached });
      const request = vi.fn<ConstructorParameters<typeof ShellCommandPaletteOwner>[1]["request"]>();
      const { owner, dispose } = createRoot((disposeRoot) => ({
        owner: new ShellCommandPaletteOwner(host, { ...emptyActions, request }),
        dispose: disposeRoot,
      }));
      onTestFinished(dispose);
      owner[action]();
      mountLoading(owner.loading, () => {});
      await vi.dynamicImportSettled();
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
      host.elements.commandPalette = replacement;
      owner.open();
      expect(replacement.openPalette).toHaveBeenCalledOnce();
      const take = replacement.openPalette.mock.calls[0]?.[0];
      expect(typeof take).toBe("function");
      expect(typeof take === "function" ? take() : undefined).toMatchObject({
        value: "Keep the replacement intent",
      });
      expect(owner.loading.active()).toBe(false);
    },
  );

  it("retains its live field and selection while the shell refreshes and locks a queued submit", async () => {
    const { state, input } = await mountLoader();
    type(input, "Keep this selection");
    input.setSelectionRange(5, 9, "backward");
    flush();
    expect(container.querySelector("textarea")).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      5,
      9,
      "backward",
    ]);
    keydown(input, { metaKey: true });
    flush();
    expect(state.submitRequested()).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(container.querySelector("textarea")).toBe(input);
  });

  it.each(["typed", "pasted", "replaced", "dropped", "composing"])(
    "preserves only a typed mention trigger: %s",
    async (mode) => {
      const { state, input } = await mountLoader();
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

  it.each(["transfer", "dismiss", "context retirement"] as const)(
    "handles pasted-file custody after %s",
    async (outcome) => {
      const { state, input } = await mountLoader();
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
      if (outcome !== "transfer") {
        if (outcome === "dismiss") {
          state.dismiss();
        } else {
          state.clear();
        }
        state.begin();
        expect(take()).toBeUndefined();
        const reopened = state.captureHandoff()();
        expect(reopened?.attachmentFiles).toEqual(outcome === "dismiss" ? [file] : undefined);
        expect(reopened?.submitRequested).toBeUndefined();
      } else {
        expect(take()).toMatchObject({ value: "", attachmentFiles: [file], submitRequested: true });
        expect(take()).toBeUndefined();
      }
    },
  );

  it("hands dropped non-image files to the canonical draft exactly once", async () => {
    const { state, input } = await mountLoader();
    const file = new File(["brief"], "brief.pdf", { type: "application/pdf" });
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
    input.dispatchEvent(event);
    flush();
    expect(event.defaultPrevented).toBe(true);
    expect(input.placeholder).toBe("What would you like to do with these files?");
    const take = state.captureHandoff();
    expect(take()?.attachmentFiles).toEqual([file]);
    expect(take()).toBeUndefined();
  });

  it.each([
    { modifier: { ctrlKey: true }, submit: true, value: "Start this background task" },
    { modifier: { metaKey: true }, submit: true, value: "Start this background task" },
    { modifier: {}, submit: false, value: "unsent prompt" },
  ])(
    "handles Enter without leaking a loading prompt ($modifier)",
    async ({ modifier, submit, value }) => {
      const { state, input, close } = await mountLoader();
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
    async ({ remount, value, start, end }) => {
      const { state, input, foreground, close } = await mountLoader();
      expect(input.disabled).toBe(false);
      type(input, remount ? value : "early draft");
      const take = state.captureHandoff();
      type(input, value);
      input.setSelectionRange(start, end, "backward");
      if (remount) {
        cleanupSolid();
        mountLoading(state, close);
        flush();
        const replacement = container.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
        expect(replacement).not.toBe(input);
        expect(replacement.value).toBe(value);
        expect([
          replacement.selectionStart,
          replacement.selectionEnd,
          replacement.selectionDirection,
        ]).toEqual([start, end, "backward"]);
        // The removed Solid root cleans up after its replacement has mounted.
        await Promise.resolve();
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
      expect(state.active()).toBe(false);
      expect(take()).toBeUndefined();
    },
  );

  it("keeps the composing field alive until its final input and selection commit", async () => {
    const { state, input } = await mountLoader();
    compose(input);
    type(input, "に");
    const accepted = vi.fn();
    const take = state.captureHandoff();
    state.handoff(() => accepted(take()));
    expect(accepted).not.toHaveBeenCalled();
    expect(state.waitingForComposition()).toBe(true);
    compose(input, true, "日本");
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

  it("retires a composition handoff when its shell owner is disposed", async () => {
    const { state, input, disposeOwner } = await mountLoader();
    compose(input);
    type(input, "retired prompt");
    const take = state.captureHandoff();
    const accepted = vi.fn();
    state.handoff(accepted);
    compose(input, true);
    disposeOwner();
    expect(take()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each(["composing", "commit-pending"] as const)(
    "retires a %s handoff without reviving its prompt on reopen",
    async (phase) => {
      const { state, input } = await mountLoader();
      compose(input);
      type(input, "retired text");
      const accepted = vi.fn();
      state.handoff(accepted);
      const take = state.captureHandoff();
      if (phase === "commit-pending") {
        compose(input, true);
      }
      state.clear();
      // A late ref/input from the old render cannot resurrect custody.
      state.inputRef(undefined);
      state.captureInput();
      state.begin();
      expect(take()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
      expect(accepted).not.toHaveBeenCalled();
      expect(state.value()).toBe("");
    },
  );
});
