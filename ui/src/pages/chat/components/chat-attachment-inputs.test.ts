/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import {
  handleChatAttachmentMenuSelection,
  renderChatAttachmentInputs,
} from "./chat-attachment-inputs.ts";

let host: HTMLDivElement;
let restoreDialog: () => void;

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  vi.stubGlobal("isSecureContext", false);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  const camera = host.querySelector("openclaw-chat-camera-capture");
  host.remove();
  await camera?.updateComplete;
  await Promise.resolve();
  restoreDialog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["agent-chat__composer-shell", "new-session-page__composer"])(
  "keeps explicit native capture scoped to %s with a single-image input",
  async (composerClass) => {
    render(
      html`<div class=${composerClass}>
        ${renderChatAttachmentInputs({ onAttachmentsChange: vi.fn() })}
        <div class="attachment-menu" @wa-select=${handleChatAttachmentMenuSelection}></div>
      </div>`,
      host,
    );
    const camera = host.querySelector("openclaw-chat-camera-capture");
    const menu = host.querySelector(".attachment-menu");
    const nativeInput = host.querySelector<HTMLInputElement>(".agent-chat__camera-input");
    const photoInput = host.querySelector<HTMLInputElement>(".agent-chat__photo-input");
    if (!camera || !menu || !nativeInput || !photoInput) {
      throw new Error("Missing attachment controls");
    }
    expect(nativeInput.accept).toBe("image/*");
    expect(nativeInput.getAttribute("capture")).toBe("environment");
    expect(nativeInput.multiple).toBe(false);
    expect(photoInput.multiple).toBe(true);
    expect(photoInput.hasAttribute("capture")).toBe(false);
    const clickNative = vi.spyOn(nativeInput, "click").mockImplementation(() => undefined);
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "camera" } } }));
    await camera.updateComplete;
    expect(clickNative).not.toHaveBeenCalled();
    const nativeButton = [...camera.renderRoot.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Use device camera",
    );
    if (!nativeButton) {
      throw new Error("Missing explicit native-camera action");
    }
    nativeButton.click();
    expect(clickNative).toHaveBeenCalledOnce();
    await camera.updateComplete;
  },
);
