/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../../test-helpers/modal-dialog.ts";
import type { OpenClawModalDialog } from "./modal-dialog.ts";
import "./modal-dialog.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

async function renderModal(
  options: {
    label?: string;
    description?: string;
    firstAction?: string;
    lastAction?: string;
  } = {},
) {
  const label = options.label ?? "Confirm action";
  const description = options.description ?? "Review the operation before continuing.";
  render(
    html`
      <openclaw-modal-dialog label=${label} description=${description}>
        <section>
          <h2 id="modal-title">${label}</h2>
          <p id="modal-description">${description}</p>
          <button id="first-action">${options.firstAction ?? "First"}</button>
          <button id="last-action">${options.lastAction ?? "Last"}</button>
        </section>
      </openclaw-modal-dialog>
    `,
    container,
  );
  return await getRenderedModalDialog(container);
}

function expectShadowElement(modal: OpenClawModalDialog, id: string): HTMLElement {
  const element = modal.shadowRoot?.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected shadow element #${id}`);
  }
  return element;
}

describe("openclaw-modal-dialog", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
    vi.restoreAllMocks();
  });

  it("opens a labelled modal dialog with an optional description", async () => {
    const { modal, dialog } = await renderModal();

    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby");
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(labelId).toBe("openclaw-modal-dialog-label");
    expect(descriptionId).toBe("openclaw-modal-dialog-description");
    expect(dialog.getRootNode()).toBe(modal.shadowRoot);
    expect(dialog.ownerDocument.querySelector(`#${labelId}`)).toBeNull();
    expect(expectShadowElement(modal, "openclaw-modal-dialog-label").textContent).toBe(
      "Confirm action",
    );
    expect(expectShadowElement(modal, "openclaw-modal-dialog-description").textContent).toBe(
      "Review the operation before continuing.",
    );
  });

  it("focuses the dialog container first", async () => {
    const { modal, dialog } = await renderModal();

    expect(modal.shadowRoot?.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(container.querySelector("#first-action"));
  });

  it("cycles Tab and Shift+Tab inside focusable dialog content", async () => {
    const { dialog } = await renderModal();
    const first = container.querySelector<HTMLButtonElement>("#first-action");
    const last = container.querySelector<HTMLButtonElement>("#last-action");
    expect(first?.id).toBe("first-action");
    expect(last?.id).toBe("last-action");
    if (!first || !last) {
      throw new Error("expected modal focus trap actions");
    }

    last.focus();
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    const shiftTab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    first.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(dialog.open).toBe(true);
  });

  it("emits modal-cancel on Escape", async () => {
    const { modal, dialog } = await renderModal();
    const onCancel = vi.fn();
    modal.addEventListener("modal-cancel", onCancel);

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reopens the same dialog instance after content changes while closed", async () => {
    const { modal, dialog } = await renderModal();
    dialog.close();
    expect(dialog.open).toBe(false);

    await renderModal({
      label: "Next approval",
      description: "Another item is pending.",
      firstAction: "Next",
    });

    const { modal: updatedModal, dialog: updatedDialog } = await getRenderedModalDialog(container);
    expect(updatedModal).toBe(modal);
    expect(updatedDialog).toBe(dialog);
    expect(dialog.open).toBe(true);
  });

  it("restores focus when closed and removed", async () => {
    const returnTarget = document.createElement("button");
    returnTarget.textContent = "Return";
    document.body.append(returnTarget);
    returnTarget.focus();

    await renderModal();
    expect(document.activeElement).not.toBe(returnTarget);

    render(nothing, container);
    await nextFrame();

    expect(document.activeElement).toBe(returnTarget);
    returnTarget.remove();
  });
});
