import { expectDefined } from "@openclaw/normalization-core";
import { assert, expect, vi } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.tsx";

export function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function afterModalHidden(modal: OpenClawModalDialog): Promise<void> {
  const dialog = expectDefined(
    modal.querySelector<HTMLDialogElement>("dialog.oc-modal-dialog"),
    "rendered native modal dialog",
  );
  if (dialog.dataset.phase === "hidden") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onHidden = (event: Event) => {
      if (event.target === modal) {
        modal.removeEventListener("overlay-after-hide", onHidden);
        resolve();
      }
    };
    modal.addEventListener("overlay-after-hide", onHidden);
  });
}

function replaceMethod(prototype: object, name: string, value: unknown, onlyIfMissing = false) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  if (onlyIfMissing && descriptor) {
    return () => {};
  }
  Object.defineProperty(prototype, name, { configurable: true, value });
  return () => {
    if (descriptor) {
      Object.defineProperty(prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(prototype, name);
    }
  };
}

export function installDialogPolyfill(): () => void {
  const restore = [
    replaceMethod(HTMLDialogElement.prototype, "showModal", function (this: HTMLDialogElement) {
      // jsdom lacks the native dialog's intrinsic focusability.
      this.tabIndex = -1;
      this.setAttribute("open", "");
    }),
    replaceMethod(HTMLDialogElement.prototype, "close", function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    }),
    replaceMethod(Element.prototype, "getAnimations", () => [], true),
  ];
  return () => restore.forEach((reset) => reset());
}

async function waitForDialog<T>(read: () => T): Promise<T> {
  // Lazy module loading is fixture setup, not part of the DOM readiness deadline.
  await vi.dynamicImportSettled();
  return vi.waitFor(read);
}

export function createModalDialogTestFixture(
  dismissModal: (modal: HTMLElement) => void = (modal) => {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  },
) {
  const restoreDialogPolyfill = installDialogPolyfill();
  const operations: Promise<unknown>[] = [];
  const requests: Promise<unknown>[] = [];
  const modals = new Set<HTMLElement>();
  const captureModals = () =>
    document.body.querySelectorAll("openclaw-modal-dialog").forEach((modal) => modals.add(modal));
  const observer = new MutationObserver(captureModals);
  observer.observe(document.body, { childList: true, subtree: true });
  let pendingCleanup: Promise<void> | undefined;

  function track<T>(completion: Promise<T>, work: Promise<unknown>[]) {
    work.push(completion);
    void completion.catch(() => {});
    return completion;
  }

  async function cleanup() {
    let results: PromiseSettledResult<unknown>[];
    try {
      // An assertion can fail before the lazy dialog exists. Catalog completion
      // can repaint its host, so join those responses before cancelling the owner.
      await vi.dynamicImportSettled();
      await Promise.allSettled(requests);
      await vi.dynamicImportSettled();
      captureModals();
      for (const modal of modals) {
        if (modal.parentElement) {
          dismissModal(modal);
        }
      }
      results = await Promise.allSettled(operations);
      await vi.dynamicImportSettled();
    } finally {
      observer.disconnect();
    }
    document.body.replaceChildren();
    restoreDialogPolyfill();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Dialog operations failed during fixture cleanup");
    }
  }

  return {
    waitFor: waitForDialog,
    track: <T>(completion: Promise<T>) => track(completion, operations),
    mockRequest: <Args extends unknown[], Result>(request: (...args: Args) => Promise<Result>) =>
      vi.fn((...args: Args) => track(request(...args), requests)),
    cleanup: () => (pendingCleanup ??= cleanup()),
  };
}

// Separate from answering so tests can change owner state while a decision is pending.
export function waitForConfirmDialogActions(): Promise<HTMLElement> {
  return waitForDialog(() =>
    expectDefined(
      document.body.querySelector<HTMLElement>("openclaw-modal-dialog .exec-approval-actions"),
      "open confirm dialog",
    ),
  );
}

export function answerConfirmDialog(
  actions: HTMLElement,
  choice: "confirm" | "alternative" | "cancel",
) {
  const selectors = {
    confirm: ".btn.danger, .btn.primary",
    alternative: ".btn:not(.danger):not(.primary):not([autofocus])",
    cancel: ".btn[autofocus]",
  };
  expectDefined(
    actions.querySelector<HTMLButtonElement>(selectors[choice]),
    "confirm dialog button",
  ).click();
}

export const waitForRenderedModalDialog = getRenderedModalDialog;

export async function waitForInputDialog(): Promise<HTMLInputElement> {
  await vi.dynamicImportSettled();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const input = document.body.querySelector("openclaw-modal-dialog input");
    if (input instanceof HTMLInputElement) {
      return input;
    }
    await nextFrame();
  }
  throw new Error("Expected an open input dialog");
}

export async function submitInputDialog(value: string): Promise<void> {
  const input = await waitForInputDialog();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextFrame();
  input.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

export async function getRenderedModalDialog(container: ParentNode) {
  const modal = await waitForDialog(() =>
    expectDefined(
      container.querySelector<OpenClawModalDialog>("openclaw-modal-dialog"),
      "openclaw-modal-dialog",
    ),
  );
  await modal.updateComplete;
  await nextFrame();
  const dialog = modal.querySelector<HTMLDialogElement>("dialog.oc-modal-dialog");
  assert(dialog instanceof HTMLDialogElement, "Expected rendered dialog");
  expect(dialog.parentElement).toBe(modal);
  await nextFrame();
  return { modal, dialog };
}
