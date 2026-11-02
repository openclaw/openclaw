/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { showToast } from "../lib/toast.ts";
import "../lib/toast-host.tsx";
import {
  afterModalHidden,
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "./modal-dialog.tsx";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
type Modal = HTMLElementTagNameMap["openclaw-modal-dialog"];
const commit = (element: { updateComplete: Promise<unknown> }) => element.updateComplete;
const dialogFor = (modal: Modal) => modal.querySelector<HTMLDialogElement>("dialog")!;
function expectClosed(modal: Modal) {
  expect(modal.open).toBe(false);
  expect(dialogFor(modal).inert).toBe(true);
}
beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  // A sibling may already have loaded the bridge, so stub the native host itself.
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
function mountModal(content: string, focus?: string) {
  const modal = document.createElement("openclaw-modal-dialog");
  modal.label = "Fixture";
  modal.innerHTML = content;
  if (focus) {
    modal.initialFocus = () => modal.querySelector<HTMLElement>(focus);
  }
  mountSolid(() => modal, { container });
  return modal;
}
function renderModal() {
  mountModal('<button id="first-action">First</button>');
  return getRenderedModalDialog(container);
}
function mountFocusModal(media = false) {
  const content = media
    ? '<button autofocus>Close</button><video controls tabindex="0"></video>'
    : "<button autofocus>Other action</button><textarea autofocus></textarea>";
  return mountModal(content, media ? "button" : "textarea");
}

it.each(["initial", "reopened"])("rejects disconnected %s layers", async (state) => {
  const modal = document.createElement("openclaw-modal-dialog");
  if (state === "reopened") {
    modal.open = false;
  }
  container.append(modal);
  if (state === "reopened") {
    await commit(modal);
  }
  modal.remove();
  if (state === "reopened") {
    modal.show();
  }
  await commit(modal);
  expect(modal.open).toBe(true);
  expect(document.openClawModalLayers?.has(modal)).not.toBe(true);
  container.append(modal);
  const { dialog } = await getRenderedModalDialog(container);
  expect(dialog.open).toBe(true);
  expect(document.openClawModalLayers?.has(modal)).toBe(true);
});

it("occludes native tabs through nesting, closing animations, and removal", async () => {
  const changes = vi.fn(),
    modalChanges: boolean[] = [];
  const unsubscribe = subscribeNativeOverlayOcclusion(changes, () => null);
  const onModalState = (event: Event) => {
    modalChanges.push((event as CustomEvent<{ open: boolean }>).detail.open);
  };
  const check = (published: boolean[], occlusion?: boolean[]) => {
    expect(modalChanges).toEqual(published);
    if (occlusion) {
      expect(changes.mock.calls).toEqual(occlusion.map((value) => [value]));
    } else {
      expect(changes).toHaveBeenLastCalledWith(published.at(-1));
    }
  };
  window.addEventListener("openclaw:native-modal-state", onModalState);
  try {
    const { modal } = await renderModal();
    const nested = document.createElement("openclaw-modal-dialog");
    modal.getOverlayContainer()!.append(nested);
    await getRenderedModalDialog(modal);
    check([true], [false, true]);
    nested.remove();
    check([true], [false, true]);
    const hidden = afterModalHidden(modal);
    modal.hide();
    await commit(modal);
    expectClosed(modal);
    // Native views remain hidden until the dialog leaves the top layer.
    check([true, false], [false, true]);
    await hidden;
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);
    await commit(modal);
    modal.show();
    await commit(modal);
    check([true, false, true]);
    modal.remove();
    check([true, false, true, false]);
    container.append(modal);
    check([true, false, true, false, true]);
    modal.remove();
    check([true, false, true, false, true, false]);
  } finally {
    window.removeEventListener("openclaw:native-modal-state", onModalState);
    unsubscribe();
  }
});

it.each([false, true])("publishes one reentrant close with veto correction (%s)", async (veto) => {
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
  await commit(modal);
  modal.show();
  expect(modal.open).toBe(veto);
  expect(changes).toEqual(veto ? [true, true] : [true, false]);
  if (veto) {
    modal.removeEventListener("overlay-hide", refuseClose);
    modal.open = false;
    expect(changes).toEqual([true, true, false]);
  }
  await afterModalHidden(modal);
  expect(dialogFor(modal).open).toBe(false);
});

it("focuses the explicit slotted input at opening commit, without a frame", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const modal = mountFocusModal();
  await commit(modal);
  expect(dialogFor(modal).open).toBe(true);
  expect(document.activeElement).toBe(container.querySelector("textarea"));
});

it.each(
  ["none", "pointer", "keyboard"].flatMap((interaction) =>
    [false, true].map((reopened) => ({ interaction, reopened })),
  ),
)(
  "honors autofocus without overriding $interaction input (reopened=$reopened)",
  async ({ interaction, reopened }) => {
    // oxlint-disable-next-line typescript/unbound-method -- Explicitly rebound with call(this).
    const showModal = HTMLDialogElement.prototype.showModal;
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      showModal.call(this);
      container.querySelector<HTMLVideoElement>("video")!.focus();
    });
    const modal = mountFocusModal(true);
    const interactAtOpening = async () => {
      await commit(modal);
      if (interaction === "none") {
        return;
      }
      const video = container.querySelector<HTMLVideoElement>("video")!;
      // Input targets slotted content only after the open attribute commits.
      video.dispatchEvent(
        interaction === "pointer"
          ? new PointerEvent("pointerdown", { bubbles: true, composed: true })
          : new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }),
      );
      video.focus();
      expect(document.activeElement).toBe(video);
    };
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
  "hands an active toast back to the app on %s",
  async (action) => {
    const shell = document.createElement("div");
    shell.className = "shell";
    const appHost = document.createElement("openclaw-toast-host");
    shell.append(appHost);
    document.body.append(shell);
    try {
      const { modal } = await renderModal();
      // Keep the toast active through the cold lazy import.
      showToast({ message: "Saved", durationMs: 60_000 });
      await commit(appHost);
      await vi.dynamicImportSettled();
      flush();
      expect(appHost.parentElement).toBe(modal.getOverlayContainer());
      const hidden = action === "hide" ? afterModalHidden(modal) : undefined;
      modal[action]();
      await commit(modal);
      if (hidden) {
        expectClosed(modal);
        await hidden;
      }
      await commit(appHost);
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
