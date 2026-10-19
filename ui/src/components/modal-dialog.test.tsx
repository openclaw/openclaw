/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { showToast } from "../lib/toast.ts";
import "../lib/toast-host.ts";
import {
  afterModalHidden,
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "./modal-dialog.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

type Modal = HTMLElementTagNameMap["openclaw-modal-dialog"];
function commitRender(element: { updateComplete: Promise<unknown> }) {
  return element.updateComplete;
}

async function atOpeningCommit(modal: Modal, assert: (dialog: HTMLDialogElement) => void) {
  await commitRender(modal);
  assert(modal.querySelector<HTMLDialogElement>(":scope > .oc-modal-dialog")!);
}

async function renderModal() {
  mountSolid(
    () => (
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
    ),
    { container },
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
    cleanupSolid();
    container.remove();
    vi.restoreAllMocks();
    restoreDialogPolyfill();
    vi.unstubAllGlobals();
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
      expect(document.openClawModalLayers?.has(modal)).not.toBe(true);

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

  it.each([false, true])(
    "publishes a reentrant close once, including its veto correction (veto=%s)",
    async (veto) => {
      const modal = document.createElement("openclaw-modal-dialog");
      modal.open = false;
      const changes: boolean[] = [];
      let closeOnOpen = true;
      modal.onOpenChange = (open) => {
        changes.push(open);
        if (open && closeOnOpen) {
          closeOnOpen = false;
          modal.open = false;
        }
      };
      const refuseClose = (event: Event) => event.preventDefault();
      if (veto) {
        modal.addEventListener("overlay-hide", refuseClose);
      }
      container.append(modal);
      await commitRender(modal);

      modal.show();
      expect(modal.open).toBe(veto);
      expect(changes).toEqual(veto ? [true, true] : [true, false]);
      if (veto) {
        modal.removeEventListener("overlay-hide", refuseClose);
        modal.open = false;
        expect(changes).toEqual([true, true, false]);
      }
      await afterModalHidden(modal);
      expect(modal.querySelector<HTMLDialogElement>("dialog")!.open).toBe(false);
    },
  );

  it("focuses the explicit slotted input at opening commit, without waiting for a frame", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    let input!: HTMLTextAreaElement;
    mountSolid(
      () => (
        <openclaw-modal-dialog label="Edit" prop:initialFocus={() => input}>
          <button autofocus>Other action</button>
          <textarea
            ref={(element) => {
              input = element;
            }}
            autofocus
          ></textarea>
        </openclaw-modal-dialog>
      ),
      { container },
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
      let closeButton!: HTMLButtonElement;
      mountSolid(
        () => (
          <openclaw-modal-dialog label="Media" prop:initialFocus={() => closeButton}>
            <button
              ref={(element) => {
                closeButton = element;
              }}
              autofocus
            >
              Close
            </button>
            <video controls tabindex="0"></video>
          </openclaw-modal-dialog>
        ),
        { container },
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

        // Keep the toast active through a cold lazy import; this test covers layer handoff.
        showToast({ message: "Saved", durationMs: 60_000 });
        await commitRender(appHost);
        await vi.dynamicImportSettled();
        flush();
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
        await vi.dynamicImportSettled();
        flush();
        expect(appHost.querySelector(".app-toast__message")?.textContent).toBe("Saved");
        expect(modal.querySelector(".app-toast")).toBeNull();
      } finally {
        shell.remove();
      }
    },
  );

  it("does not restore the original trigger when a suppressed modal is removed", async () => {
    const originalTrigger = document.createElement("button");
    document.body.append(originalTrigger);
    originalTrigger.focus();
    const { modal } = await renderModal();

    modal.setReturnFocusTarget(null);
    container.querySelector<HTMLElement>("#first-action")?.focus();
    cleanupSolid();
    await nextFrame();

    expect(document.activeElement).not.toBe(originalTrigger);
    originalTrigger.remove();
  });
});
