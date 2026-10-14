/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
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

it("keeps the camera idle across unchanged input renders while retaining reactive disabled and read scopes", async () => {
  const props: ChatAttachmentControlsProps = {
    readSignal: new AbortController().signal,
    onAttachmentsChange: vi.fn(),
  };
  render(renderChatAttachmentInputs(props), host);
  const camera = host.querySelector("openclaw-chat-camera-capture")!;
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);

  render(renderChatAttachmentInputs(props), host);
  await camera.updateComplete;
  expect(host.querySelector("openclaw-chat-camera-capture")).toBe(camera);
  expect(camera.childElementCount).toBe(0);

  render(renderChatAttachmentInputs({ ...props, draft: "A new draft" }), host);
  await camera.updateComplete;
  expect(host.querySelector("openclaw-chat-camera-capture")).toBe(camera);
  expect(camera.childElementCount).toBe(0);

  render(renderChatAttachmentInputs({ ...props, disabled: true }), host);
  await camera.updateComplete;
  expect(camera.disabled).toBe(true);
  camera.show();
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);

  const readSignal = new AbortController().signal;
  render(
    renderChatAttachmentInputs({
      ...props,
      disabled: true,
      readSignal,
    }),
    host,
  );
  await camera.updateComplete;
  expect(camera.readSignal).toBe(readSignal);
  expect(camera.childElementCount).toBe(0);
});

it.each(
  ["agent-chat__composer-shell", "new-session-page__composer"].flatMap((composerClass) =>
    [false, true].map((android) => ({ composerClass, android })),
  ),
)(
  "keeps native capture scoped to $composerClass with a single-image input (Android: $android)",
  async ({ composerClass, android }) => {
    if (android) {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
      );
    }
    const initialProps = { onAttachmentsChange: vi.fn(), disabled: false };
    const draw = (props: ChatAttachmentControlsProps) =>
      render(
        html`<div class=${composerClass}>
          ${renderChatAttachmentInputs(props)}
          <div class="attachment-menu" @wa-select=${handleChatAttachmentMenuSelection}></div>
        </div>`,
        host,
      );
    draw(initialProps);
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
    await camera.updateComplete;
    // A callback retained from the earlier render would now reject this picker.
    initialProps.disabled = true;
    draw({ ...initialProps, disabled: false });
    await camera.updateComplete;
    const clickNative = vi.spyOn(nativeInput, "click").mockImplementation(() => undefined);
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "camera" } } }));
    await camera.updateComplete;
    if (android) {
      expect(clickNative).toHaveBeenCalledOnce();
      expect(camera.querySelector("openclaw-modal-dialog")).toBeNull();
    } else {
      expect(clickNative).not.toHaveBeenCalled();
      const nativeButton = [...camera.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Use device camera",
      );
      if (!nativeButton) {
        throw new Error("Missing explicit native-camera action");
      }
      nativeButton.click();
      expect(clickNative).toHaveBeenCalledOnce();
      await camera.updateComplete;
    }
    for (const unavailable of [
      { disabled: true },
      { cameraActive: false },
      { readSignal: AbortSignal.abort() },
    ]) {
      draw({ ...initialProps, disabled: false, ...unavailable });
      await camera.updateComplete;
      menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "camera" } } }));
      expect(clickNative).toHaveBeenCalledOnce();
      expect(camera.querySelector("openclaw-modal-dialog")).toBeNull();
    }
  },
);

it("leaves the general file picker unrestricted while photo and camera stay image-only", () => {
  render(renderChatAttachmentInputs({ onAttachmentsChange: vi.fn() }), host);
  const input = (kind: string) =>
    host.querySelector<HTMLInputElement>(`.agent-chat__${kind}-input`);
  // General files share chat admission; Android greys out anything outside an accept list.
  expect(input("file")?.hasAttribute("accept")).toBe(false);
  expect(input("photo")?.accept).toBe("image/*");
  expect(input("camera")?.accept).toBe("image/*");
});
