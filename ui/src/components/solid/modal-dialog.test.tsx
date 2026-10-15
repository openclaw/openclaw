/* @vitest-environment jsdom */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, untrack } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { ModalDialog, OpenClawModalDialog, type ModalDialogProperties } from "../modal-dialog.ts";

function modalDialog(host: OpenClawModalDialog): HTMLDialogElement {
  const dialog = host.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog");
  if (!dialog) {
    throw new Error("Expected native modal dialog");
  }
  return dialog;
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

function mount(
  props: Partial<ModalDialogProperties> & { onCancel?: (event: Event) => void } = {},
  container?: HTMLElement,
) {
  let handle!: OpenClawModalDialog;
  const view = render(
    () => (
      <ModalDialog
        open={props.open}
        manual={props.manual}
        label={props.label}
        description={props.description}
        onOpenChange={props.onOpenChange}
        ref={(value) => {
          handle = value;
          if (props.onCancel) {
            handle.addEventListener("modal-cancel", props.onCancel);
          }
        }}
      >
        <button autofocus>Confirm</button>
        <textarea aria-label="Notes" />
      </ModalDialog>
    ),
    container ? { container } : undefined,
  );
  flush();
  return {
    view,
    get handle() {
      return handle;
    },
  };
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
    let handle!: OpenClawModalDialog;
    render(() => (
      <ModalDialog
        label="Confirm action"
        description={description()}
        open={open()}
        ref={(value) => {
          handle = value;
        }}
      >
        <textarea aria-label="Draft" autofocus />
      </ModalDialog>
    ));
    flush();
    const draft = modalDialog(handle).querySelector("textarea");
    expect(handle).toBeInstanceOf(OpenClawModalDialog);
    expect(modalDialog(handle).open).toBe(true);
    expect(modalDialog(handle).getAttribute("role")).toBe("dialog");
    expect(modalDialog(handle).getAttribute("aria-modal")).toBe("true");
    expect(modalDialog(handle).getAttribute("aria-label")).toBe("Confirm action");
    expect(modalDialog(handle).getAttribute("aria-description")).toBe("Review the operation");
    expect(document.openClawModalLayers?.has(handle)).toBe(true);
    setDescription("");
    setOpen(false);
    flush();
    expect(modalDialog(handle).hasAttribute("aria-description")).toBe(false);
    expect(modalDialog(handle).open).toBe(false);
    expect(document.openClawModalLayers?.has(handle)).toBe(false);
    setOpen(true);
    flush();
    expect(modalDialog(handle).open).toBe(true);
    expect(modalDialog(handle).querySelector("textarea")).toBe(draft);
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
      let host!: OpenClawModalDialog;
      render(() => (
        <ModalDialog
          open={open()}
          onOpenChange={changes}
          ref={(element) => {
            host = element;
          }}
        >
          <button autofocus>Confirm</button>
        </ModalDialog>
      ));
      flush();
      changes.mockClear();
      const eventName = operation === "show" ? "overlay-show" : "overlay-hide";
      const veto = (event: Event) => event.preventDefault();
      host.addEventListener(eventName, veto);
      setOpen(!initial);
      flush();
      expect(untrack(open)).toBe(initial);
      expect(host.open).toBe(initial);
      expect(modalDialog(host).open).toBe(initial);
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
    let host!: OpenClawModalDialog;
    const changes = vi.fn((next: boolean) => {
      setOpen(next);
      if (next) {
        host.hide();
      }
    });
    render(() => (
      <ModalDialog
        open={open()}
        onOpenChange={changes}
        ref={(element) => {
          host = element;
        }}
      >
        <button autofocus>Confirm</button>
      </ModalDialog>
    ));
    flush();
    setOpen(true);
    flush();
    expect(untrack(open)).toBe(false);
    expect(host.open).toBe(false);
    expect(modalDialog(host).open).toBe(false);
    expect(changes.mock.calls).toEqual([[true], [false]]);
  });

  it("retires a disconnected dialog without canceling or changing its owner's desired state", () => {
    const changes = vi.fn();
    const onCancel = vi.fn();
    const { handle } = mount({ onOpenChange: changes, onCancel });
    const parent = handle.parentNode!;
    changes.mockClear();
    const hiding: Event[] = [];
    handle.addEventListener("overlay-hide", (event) => {
      hiding.push(event);
      event.preventDefault();
    });
    handle.remove();
    expect(handle.open).toBe(true);
    expect(modalDialog(handle).open).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(hiding).toHaveLength(0);
    expect(changes).not.toHaveBeenCalled();
    parent.appendChild(handle);
    flush();
    expect(handle.open).toBe(true);
    expect(modalDialog(handle).open).toBe(true);
    expect(changes).not.toHaveBeenCalled();
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
        expect(handle.open).toBe(true);
        expect(modalDialog(handle).open).toBe(true);
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
      expect(outer.handle.open).toBe(false);
      expect(inner.handle.open).toBe(false);
      expect(modalDialog(outer.handle).open).toBe(false);
      expect(modalDialog(inner.handle).open).toBe(false);
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

  it("never publishes a superseded close completion after reopening", async () => {
    const { handle } = mount();
    await completeFrames();
    const hidden = vi.fn();
    const shown = vi.fn();
    handle.addEventListener("overlay-after-hide", hidden);
    handle.addEventListener("overlay-after-show", shown);
    handle.hide();
    handle.show();
    await completeFrames();
    expect(hidden).not.toHaveBeenCalled();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(handle.open).toBe(true);
    expect(modalDialog(handle).dataset.phase).toBe("open");
  });

  it("disposal cancels pending completion and removes modal ownership", async () => {
    const { handle, view } = mount();
    const dialog = modalDialog(handle);
    const shown = vi.fn();
    handle.addEventListener("overlay-after-show", shown);
    view.unmount();
    await completeFrames();
    expect(shown).not.toHaveBeenCalled();
    expect(dialog.open).toBe(false);
    expect(handle.querySelector(".oc-modal-dialog")).toBeNull();
    expect(document.openClawModalLayers?.has(handle)).toBe(false);
    expect(document.documentElement.classList.contains("oc-modal-scroll-lock")).toBe(false);
  });
});
