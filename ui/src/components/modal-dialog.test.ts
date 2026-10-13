/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { showToast } from "../lib/toast.ts";
import {
  afterModalHidden,
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../test-helpers/modal-dialog.ts";
import "./modal-dialog.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

type Modal = HTMLElementTagNameMap["openclaw-modal-dialog"];
const modalTransitionEvents = {
  opening: "wa-show",
  opened: "wa-after-show",
  closing: "wa-hide",
  closed: "wa-after-hide",
} as const;

function commitRender(element: { updateComplete: Promise<unknown> }) {
  return element.updateComplete;
}

function notifyNestedTransitions(target: Element) {
  for (const type of Object.values(modalTransitionEvents)) {
    target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }
}

async function atOpeningCommit(modal: Modal, assert: (dialog: HTMLDialogElement) => void) {
  await commitRender(modal);
  assert(modal.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!);
}

async function renderModal() {
  render(
    html`
      <openclaw-modal-dialog
        label="Confirm action"
        description="Review the operation before continuing."
      >
        <section>
          <h2 id="modal-title">Confirm action</h2>
          <p id="modal-description">Review the operation before continuing.</p>
          <button id="first-action">First</button>
          <button id="last-action">Last</button>
        </section>
      </openclaw-modal-dialog>
    `,
    container,
  );
  const { modal, dialog } = await getRenderedModalDialog(container);
  return { modal, dialog };
}

describe("openclaw-modal-dialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    // A later module mock cannot replace a bridge already loaded by a sibling suite.
    vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.restoreAllMocks();
    restoreDialogPolyfill();
    vi.unstubAllGlobals();
  });

  it("opens a labelled modal dialog with an optional description", async () => {
    const { modal, dialog } = await renderModal();

    expect(dialog.open).toBe(true);
    expect(dialog.localName).toBe("dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Confirm action");
    expect(dialog.getAttribute("aria-description")).toBe("Review the operation before continuing.");
    expect(dialog.isConnected).toBe(true);
    expect(document.openClawModalLayers?.has(modal)).toBe(true);

    modal.hide();
    await commitRender(modal);
    expect(document.openClawModalLayers?.has(modal)).toBe(false);

    modal.show();
    await commitRender(modal);
    expect(document.openClawModalLayers?.has(modal)).toBe(true);

    modal.remove();
    expect(document.openClawModalLayers?.has(modal)).toBe(false);
  });

  it.each(["initial", "reopened"] as const)(
    "does not restore a disconnected modal layer after its %s update",
    async (state) => {
      const modal = document.createElement("openclaw-modal-dialog");
      if (state === "reopened") {
        modal.open = false;
      }
      container.append(modal);
      if (state === "reopened") {
        await commitRender(modal);
      }
      modal.remove();
      if (state === "reopened") {
        modal.show();
      }
      await commitRender(modal);

      expect(modal.open).toBe(true);
      expect(document.openClawModalLayers?.has(modal)).toBe(false);

      container.append(modal);
      const { dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(true);
      expect(document.openClawModalLayers?.has(modal)).toBe(true);
    },
  );

  it("occludes native tabs through nested dialogs, closing animations, and removal", async () => {
    const changes = vi.fn();
    const unsubscribe = subscribeNativeOverlayOcclusion(changes, () => null);
    const modalChanges: boolean[] = [];
    const onModalState = (event: Event) => {
      modalChanges.push((event as CustomEvent<{ open: boolean }>).detail.open);
    };
    window.addEventListener("openclaw:native-modal-state", onModalState);
    try {
      const { modal } = await renderModal();
      const nested = document.createElement("openclaw-modal-dialog");
      modal.getOverlayContainer()!.append(nested);
      await getRenderedModalDialog(modal);
      expect(changes.mock.calls).toEqual([[false], [true]]);
      expect(modalChanges).toEqual([true]);

      nested.remove();
      expect(changes.mock.calls).toEqual([[false], [true]]);
      expect(modalChanges).toEqual([true]);
      const hidden = afterModalHidden(modal);
      modal.hide();
      await commitRender(modal);
      expect(modal.open).toBe(false);
      expect(modal.querySelector<HTMLDialogElement>("dialog")!.inert).toBe(true);
      expect(modalChanges).toEqual([true, false]);
      // The platform view must stay hidden until the dialog leaves the top layer.
      expect(changes.mock.calls).toEqual([[false], [true]]);
      await hidden;
      expect(changes.mock.calls).toEqual([[false], [true], [false]]);
      await commitRender(modal);
      modal.show();
      await commitRender(modal);
      expect(changes).toHaveBeenLastCalledWith(true);
      expect(modalChanges).toEqual([true, false, true]);
      modal.remove();
      expect(changes).toHaveBeenLastCalledWith(false);
      expect(modalChanges).toEqual([true, false, true, false]);
      container.append(modal);
      expect(changes).toHaveBeenLastCalledWith(true);
      expect(modalChanges).toEqual([true, false, true, false, true]);
      modal.remove();
      expect(changes).toHaveBeenLastCalledWith(false);
      expect(modalChanges).toEqual([true, false, true, false, true, false]);
    } finally {
      window.removeEventListener("openclaw:native-modal-state", onModalState);
      unsubscribe();
    }
  });

  it("focuses the dialog container first", async () => {
    const focus = vi.spyOn(HTMLDialogElement.prototype, "focus");
    const { dialog } = await renderModal();

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).not.toBe(container.querySelector("#first-action"));
    expect(dialog.open).toBe(true);
  });

  it("focuses slotted autofocus content", async () => {
    render(
      html`<openclaw-modal-dialog label="Edit">
        <textarea id="autofocus-target" autofocus></textarea>
      </openclaw-modal-dialog>`,
      container,
    );
    await getRenderedModalDialog(container);

    expect(document.activeElement).toBe(container.querySelector("#autofocus-target"));
  });

  it("focuses slotted input once the opening update commits, without waiting for a frame", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(
      html`<openclaw-modal-dialog label="Edit">
        <textarea autofocus></textarea>
      </openclaw-modal-dialog>`,
      container,
    );
    const modal = container.querySelector("openclaw-modal-dialog")!;
    await atOpeningCommit(modal, (dialog) => {
      expect(dialog.open).toBe(true);
      expect(document.activeElement).toBe(container.querySelector("textarea"));
    });
  });

  it.each(
    ["none", "pointer", "keyboard"].flatMap((interaction) =>
      [false, true].map((reopened) => ({ interaction, reopened })),
    ),
  )(
    "honors autofocus without overriding $interaction input (reopened=$reopened)",
    async ({ interaction, reopened }) => {
      // oxlint-disable-next-line typescript/unbound-method -- The saved method is explicitly rebound with call(this) below.
      const showModal = HTMLDialogElement.prototype.showModal;
      vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
        this: HTMLDialogElement,
      ) {
        showModal.call(this);
        container.querySelector<HTMLVideoElement>("video")!.focus();
      });
      render(
        html`<openclaw-modal-dialog label="Media"
          ><button autofocus>Close</button><video controls tabindex="0"></video
        ></openclaw-modal-dialog>`,
        container,
      );
      const modal = container.querySelector("openclaw-modal-dialog")!;
      const interactAtOpening = () =>
        atOpeningCommit(modal, () => {
          if (interaction === "none") {
            return;
          }
          const video = container.querySelector<HTMLVideoElement>("video")!;
          // showModal runs before the host's open attribute is committed. User
          // input can only target its slotted content once that content is usable.
          video.dispatchEvent(
            interaction === "pointer"
              ? new PointerEvent("pointerdown", { bubbles: true, composed: true })
              : new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }),
          );
          video.focus();
          expect(document.activeElement).toBe(video);
        });
      await interactAtOpening();
      const { dialog } = await getRenderedModalDialog(container);
      if (reopened) {
        modal.hide();
        await vi.waitFor(() => expect(dialog.open).toBe(false));
        modal.show();
        await interactAtOpening();
        await getRenderedModalDialog(container);
      }
      expect(document.activeElement).toBe(
        container.querySelector(interaction !== "none" ? "video" : "button"),
      );
    },
  );

  it("keeps focus on a field the user selected when the show animation settles", async () => {
    render(
      html`<openclaw-modal-dialog label="Edit">
        <input id="autofocus-target" autofocus />
        <textarea id="notes-field"></textarea>
      </openclaw-modal-dialog>`,
      container,
    );
    await getRenderedModalDialog(container);
    const notes = container.querySelector<HTMLTextAreaElement>("#notes-field");
    notes?.focus();

    await nextFrame();

    expect(document.activeElement).toBe(notes);
  });

  it.each(["hide", "remove"] as const)(
    "hands an active toast back to the app layer on %s",
    async (action) => {
      const shell = document.createElement("div");
      shell.className = "shell";
      const appHost = document.createElement("openclaw-toast-host");
      shell.append(appHost);
      document.body.append(shell);
      try {
        const { modal } = await renderModal();

        showToast({ message: "Saved" });
        expect(appHost.parentElement).toBe(modal.getOverlayContainer());
        const hidden = action === "hide" ? afterModalHidden(modal) : undefined;
        modal[action]();
        await commitRender(modal);
        if (hidden) {
          expect(modal.open).toBe(false);
          expect(modal.querySelector<HTMLDialogElement>("dialog")!.inert).toBe(true);
          await hidden;
        }
        await commitRender(appHost);

        expect(appHost.parentElement).toBe(shell);
        expect(appHost.querySelector(".app-toast__message")?.textContent).toBe("Saved");
        expect(modal.querySelector(".app-toast")).toBeNull();
      } finally {
        shell.remove();
      }
    },
  );

  it("emits modal-cancel on Escape", async () => {
    const { modal, dialog } = await renderModal();
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("emits modal-cancel when the backdrop is clicked", async () => {
    const { modal, dialog } = await renderModal();
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores lifecycle events from tooltips and menus nested in the modal", async () => {
    const { modal, dialog } = await renderModal();
    const nestedSurface = container.querySelector("#first-action");
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    notifyNestedTransitions(nestedSurface!);

    expect(onCancel).not.toHaveBeenCalled();
    expect(modal.open).toBe(true);
    expect(dialog.open).toBe(true);
  });

  it("restores focus when closed and removed", async () => {
    const returnTarget = document.createElement("button");
    returnTarget.textContent = "Return";
    document.body.append(returnTarget);
    returnTarget.focus();

    await renderModal();

    render(nothing, container);
    await nextFrame();

    expect(document.activeElement).toBe(returnTarget);
    returnTarget.remove();
  });

  it("restores the explicit owner target after the dialog restores its original trigger", async () => {
    const originalTrigger = document.createElement("button");
    const returnTarget = document.createElement("button");
    document.body.append(originalTrigger, returnTarget);
    originalTrigger.focus();
    const { modal } = await renderModal();

    modal.setReturnFocusTarget(returnTarget);
    const hidden = afterModalHidden(modal);
    modal.hide();
    await hidden;

    expect(document.activeElement).toBe(returnTarget);
    originalTrigger.remove();
    returnTarget.remove();
  });

  it("suppresses original-trigger restoration when the owner closes without focus", async () => {
    const originalTrigger = document.createElement("button");
    document.body.append(originalTrigger);
    originalTrigger.focus();
    const { modal } = await renderModal();

    modal.setReturnFocusTarget(null);
    const hidden = afterModalHidden(modal);
    modal.hide();
    await hidden;

    expect(document.activeElement).not.toBe(originalTrigger);
    originalTrigger.remove();
  });

  it("does not restore the original trigger when a suppressed modal is removed", async () => {
    const originalTrigger = document.createElement("button");
    document.body.append(originalTrigger);
    originalTrigger.focus();
    const { modal } = await renderModal();

    modal.setReturnFocusTarget(null);
    container.querySelector<HTMLElement>("#first-action")?.focus();
    render(nothing, container);
    await nextFrame();

    expect(document.activeElement).not.toBe(originalTrigger);
    originalTrigger.remove();
  });

  it("reopens the same dialog element after reconnect", async () => {
    const focus = vi.spyOn(HTMLDialogElement.prototype, "focus");
    const { modal, dialog } = await renderModal();
    const initialFocusCalls = focus.mock.calls.length;

    modal.remove();
    expect(dialog.open).toBe(false);

    container.append(modal);
    await commitRender(modal);
    await nextFrame();

    expect(dialog.open).toBe(true);
    expect(focus.mock.calls.length).toBeGreaterThan(initialFocusCalls);
  });
});
