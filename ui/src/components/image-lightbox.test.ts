/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "./image-lightbox.ts";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;

async function renderLightbox() {
  render(
    html`<openclaw-image-lightbox
      src="data:image/png;base64,cG5n"
      title="Generated lobster"
    ></openclaw-image-lightbox>`,
    container,
  );
  const modal = container.querySelector("openclaw-image-lightbox");
  if (!modal) {
    throw new Error("missing image lightbox");
  }
  await modal.updateComplete;
  const dialogAdapter = modal.shadowRoot?.querySelector("openclaw-modal-dialog");
  if (!dialogAdapter) {
    throw new Error("missing modal dialog adapter");
  }
  await getRenderedModalDialog((modal.shadowRoot ?? modal) as unknown as HTMLElement);
  return { modal, dialogAdapter };
}

describe("openclaw-image-lightbox", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
  });

  it("renders a labelled large image with original and close actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;

    expect(root?.querySelector<HTMLImageElement>("img")?.alt).toBe("Generated lobster");
    expect(root?.querySelector<HTMLImageElement>("img")?.src).toBe("data:image/png;base64,cG5n");
    expect(root?.querySelector<HTMLAnchorElement>("a")?.href).toBe("data:image/png;base64,cG5n");
    expect(root?.querySelector<HTMLButtonElement>("button")?.hasAttribute("autofocus")).toBe(true);
  });

  it("keeps Tab focus within the lightbox actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;
    const openOriginal = root?.querySelector<HTMLAnchorElement>(".open-original");
    const closeButton = root?.querySelector<HTMLButtonElement>(".close");
    closeButton?.focus();

    closeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root?.activeElement).toBe(openOriginal);

    openOriginal?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(root?.activeElement).toBe(closeButton);
  });

  it("emits one close event for the close button and modal cancellation", async () => {
    const { modal, dialogAdapter } = await renderLightbox();
    let closes = 0;
    modal.addEventListener("image-lightbox-close", () => {
      closes += 1;
    });

    modal.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
    expect(closes).toBe(1);

    dialogAdapter.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(closes).toBe(2);
  });
});
