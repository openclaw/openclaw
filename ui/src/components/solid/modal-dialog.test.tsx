/* @vitest-environment jsdom */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, untrack } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { ModalDialog, OpenClawModalDialog, type ModalDialogProperties } from "../modal-dialog.tsx";

const modalDialog = (host: OpenClawModalDialog) =>
  host.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!;

function expectOpen(host: OpenClawModalDialog, open: boolean) {
  expect([host.open, modalDialog(host).open]).toEqual([open, open]);
}

let restoreDialog: () => void;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

async function completeFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) {
    frame(0);
  }
  await Promise.resolve();
  await Promise.resolve();
}

function mount(props: Partial<ModalDialogProperties> = {}, container?: HTMLElement) {
  let handle!: OpenClawModalDialog;
  let confirm!: HTMLButtonElement;
  const view = render(
    () => (
      <ModalDialog
        open={props.open}
        manual={props.manual}
        label={props.label}
        description={props.description}
        onOpenChange={props.onOpenChange}
        initialFocus={() => confirm}
        ref={(value) => {
          handle = value;
        }}
      >
        <button autofocus ref={(element) => (confirm = element)}>
          Confirm
        </button>
        <textarea aria-label="Notes" />
      </ModalDialog>
    ),
    container ? { container } : undefined,
  );
  flush();
  return { view, handle };
}

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
});

afterEach(() => {
  cleanup();
  restoreDialog();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Solid native modal policy", () => {
  it("opens a labelled dialog and updates controlled attributes without replacing content", () => {
    const [description, setDescription] = createSignal("Review the operation");
    const [open, setOpen] = createSignal(true);
    const { handle } = mount({
      label: "Confirm action",
      get description() {
        return description();
      },
      get open() {
        return open();
      },
    });
    const dialog = modalDialog(handle);
    const draft = dialog.querySelector("textarea");
    expect(handle).toBeInstanceOf(OpenClawModalDialog);
    expect(dialog.open).toBe(true);
    expect(
      ["role", "aria-modal", "aria-label", "aria-description"].map((name) =>
        dialog.getAttribute(name),
      ),
    ).toEqual(["dialog", "true", "Confirm action", "Review the operation"]);
    expect(document.openClawModalLayers?.has(handle)).toBe(true);
    setDescription("");
    setOpen(false);
    flush();
    expect(dialog.hasAttribute("aria-description")).toBe(false);
    expect(dialog.open).toBe(false);
    expect(document.openClawModalLayers?.has(handle)).toBe(false);
    setOpen(true);
    flush();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("textarea")).toBe(draft);
  });

  it("publishes each lifecycle phase once from the host with settled focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    try {
      const { handle } = mount({ manual: true });
      const confirm = handle.querySelector("button");
      const phases = ["overlay-show", "overlay-after-show", "overlay-hide", "overlay-after-hide"];
      const captured: { event: Event; focus: Element | null }[] = [];
      const bubbled = vi.fn();
      for (const phase of phases) {
        handle.addEventListener(
          phase,
          (event) => captured.push({ event, focus: document.activeElement }),
          true,
        );
        handle.addEventListener(phase, bubbled);
      }
      handle.show();
      await completeFrames();
      handle.hide();
      await completeFrames();

      expect(captured.map(({ event }) => event.type)).toEqual(phases);
      expect(captured.map(({ event }) => event.target)).toEqual(phases.map(() => handle));
      expect(captured.map(({ event }) => event.cancelable)).toEqual([true, false, true, false]);
      expect(bubbled).toHaveBeenCalledTimes(4);
      expect(captured[1]?.focus).toBe(confirm);
      expect(captured[3]?.focus).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it.each(["show", "hide"] as const)(
    "rolls back the controlled signal after a vetoed %s without duplicate publications",
    (operation) => {
      const initial = operation === "hide";
      const [open, setOpen] = createSignal(initial);
      const changes = vi.fn((next: boolean) => setOpen(next));
      const { handle: host } = mount({
        get open() {
          return open();
        },
        onOpenChange: changes,
      });
      changes.mockClear();
      const eventName = operation === "show" ? "overlay-show" : "overlay-hide";
      const veto = (event: Event) => event.preventDefault();
      host.addEventListener(eventName, veto);
      setOpen(!initial);
      flush();
      expect(untrack(open)).toBe(initial);
      expectOpen(host, initial);
      expect(changes.mock.calls).toEqual([[initial]]);
      flush();
      expect(changes.mock.calls).toEqual([[initial]]);
      host.removeEventListener(eventName, veto);
      setOpen(!initial);
      flush();
      expect(untrack(open)).toBe(!initial);
      expect(modalDialog(host).open).toBe(!initial);
      expect(changes.mock.calls).toEqual([[initial], [!initial]]);
    },
  );

  it("keeps only current publications when the controlled owner closes during opening", () => {
    const [open, setOpen] = createSignal(false);
    const changes = vi.fn((next: boolean) => {
      setOpen(next);
      if (next) {
        host.hide();
      }
    });
    const { handle: host } = mount({
      get open() {
        return open();
      },
      onOpenChange: changes,
    });
    setOpen(true);
    flush();
    expect(untrack(open)).toBe(false);
    expectOpen(host, false);
    expect(changes.mock.calls).toEqual([[true], [false]]);
  });

  it.each(["cancel", "backdrop"])(
    "supports a late veto of %s before changing ownership",
    async (source) => {
      const { handle } = mount();
      await completeFrames();
      const active = document.activeElement;
      const veto = (event: Event) => event.preventDefault();
      document.addEventListener("modal-cancel", veto);
      try {
        modalDialog(handle).dispatchEvent(
          source === "cancel"
            ? new Event("cancel", { bubbles: true, cancelable: true })
            : new MouseEvent("mousedown", { bubbles: true, detail: 1 }),
        );
        expectOpen(handle, true);
        expect(modalDialog(handle).dataset.phase).toBe("open");
        expect(modalDialog(handle).inert).toBe(false);
        expect(document.activeElement).toBe(active);
        expect(document.openClawModalLayers?.has(handle)).toBe(true);
      } finally {
        document.removeEventListener("modal-cancel", veto);
      }
    },
  );

  it("a cancellation listener can hide without reentering the accepted close", async () => {
    const { handle } = mount();
    const hiding = vi.fn();
    const hidden = vi.fn();
    handle.addEventListener("modal-cancel", () => handle.hide());
    handle.addEventListener("overlay-hide", hiding);
    handle.addEventListener("overlay-after-hide", hidden);
    modalDialog(handle).dispatchEvent(new Event("cancel", { cancelable: true }));
    await completeFrames();
    expect(handle.open).toBe(false);
    expect(hiding).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledTimes(1);
  });

  it("closing a parent closes nested dialogs and preserves its final focus return", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const changes = vi.fn();
    const unsubscribe = subscribeNativeOverlayOcclusion(changes, () => null);
    try {
      const outer = mount();
      outer.view.getByRole("textbox").focus();
      const nested = document.createElement("div");
      modalDialog(outer.handle).append(nested);
      const inner = mount({}, nested);
      await completeFrames();
      expect(inner.handle.open).toBe(true);
      outer.handle.hide();
      expectOpen(outer.handle, false);
      expectOpen(inner.handle, false);
      expect(document.openClawModalLayers?.size).toBe(0);
      expect(document.activeElement).toBe(trigger);
      await completeFrames();
      expect(document.activeElement).toBe(trigger);
      expect(changes.mock.calls).toEqual([[false], [true], [false]]);
      expect(document.documentElement.classList.contains("oc-modal-scroll-lock")).toBe(false);
    } finally {
      unsubscribe();
      trigger.remove();
    }
  });
});
