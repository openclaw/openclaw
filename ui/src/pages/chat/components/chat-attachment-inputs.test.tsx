/* @vitest-environment jsdom */

import { createSignal, flush, onSettled } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";

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
  cleanupSolid();
  host.remove();
  await camera?.updateComplete;
  await Promise.resolve();
  restoreDialog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountInputs(
  initial: ChatAttachmentControlsProps,
  composerClass?: string,
  inputHandle = createChatAttachmentInputHandle(),
  container = host,
) {
  let update!: (props: ChatAttachmentControlsProps) => void;
  mountSolid(
    () => {
      const [props, setProps] = createSignal(initial);
      let trigger: HTMLButtonElement | undefined;
      onSettled(() => inputHandle.bindAnchor(trigger));
      update = (next) => {
        setProps(next);
        flush();
      };
      return composerClass ? (
        <div class={composerClass}>
          <ChatAttachmentInputs {...props()} inputHandle={inputHandle} />
          <button
            ref={(element) => {
              trigger = element;
            }}
            class="attachment-menu"
            onClick={() => inputHandle.open("camera")}
          >
            Take photo
          </button>
        </div>
      ) : (
        <ChatAttachmentInputs {...props()} inputHandle={inputHandle} />
      );
    },
    { container },
  );
  return update;
}

it("retains the camera across input renders and retires its active read scope", async () => {
  const props: ChatAttachmentControlsProps = {
    readSignal: new AbortController().signal,
    onAttachmentsChange: vi.fn(),
  };
  const draw = mountInputs(props);
  const camera = host.querySelector("openclaw-chat-camera-capture")!;
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);

  draw(props);
  await camera.updateComplete;
  expect(host.querySelector("openclaw-chat-camera-capture")).toBe(camera);
  expect(camera.childElementCount).toBe(0);

  draw({ ...props, draft: "A new draft" });
  await camera.updateComplete;
  expect(host.querySelector("openclaw-chat-camera-capture")).toBe(camera);
  expect(camera.childElementCount).toBe(0);

  draw({ ...props, disabled: true });
  await camera.updateComplete;
  expect(camera.disabled).toBe(true);
  camera.show();
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);

  const readSignal = new AbortController().signal;
  draw({ ...props, disabled: true, readSignal });
  await camera.updateComplete;
  expect(camera.readSignal).toBe(readSignal);
  expect(camera.childElementCount).toBe(0);

  draw({ ...props, disabled: false, readSignal });
  await camera.updateComplete;
  camera.show();
  await camera.updateComplete;
  expect(camera.querySelector("openclaw-modal-dialog")).not.toBeNull();
  draw({ ...props, readSignal: new AbortController().signal });
  await waitForSolid(() => expect(camera.querySelector("openclaw-modal-dialog")).toBeNull());
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
    const draw = mountInputs(initialProps, composerClass);
    const camera = host.querySelector("openclaw-chat-camera-capture");
    const menu = host.querySelector<HTMLButtonElement>(".attachment-menu");
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
    const rectangle = vi
      .spyOn(menu, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(12, 24, 36, 48));
    menu.click();
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
      rectangle.mockReturnValue(new DOMRect(90, 100, 110, 120));
      nativeButton.click();
      expect(clickNative).toHaveBeenCalledOnce();
      await camera.updateComplete;
    }
    expect(rectangle).toHaveBeenCalledOnce();
    expect(nativeInput.style.left).toBe(android ? "12px" : "90px");
    expect(nativeInput.style.top).toBe(android ? "24px" : "100px");
    for (const unavailable of [
      { disabled: true },
      { cameraActive: false },
      { readSignal: AbortSignal.abort() },
    ]) {
      draw({ ...initialProps, disabled: false, ...unavailable });
      await camera.updateComplete;
      menu.click();
      expect(clickNative).toHaveBeenCalledOnce();
      expect(camera.querySelector("openclaw-modal-dialog")).toBeNull();
    }
  },
);

it("leaves the general file picker unrestricted while photo and camera stay image-only", () => {
  mountInputs({ onAttachmentsChange: vi.fn() });
  const input = (kind: string) =>
    host.querySelector<HTMLInputElement>(`.agent-chat__${kind}-input`);
  // General files share chat admission; Android greys out anything outside an accept list.
  expect(input("file")?.hasAttribute("accept")).toBe(false);
  expect(input("photo")?.accept).toBe("image/*");
  expect(input("camera")?.accept).toBe("image/*");
});

it("keeps mounted picker refs scoped and refreshes their anchor rectangle on every activation", () => {
  const first = document.createElement("div");
  const second = document.createElement("div");
  host.append(first, second);
  const firstHandle = createChatAttachmentInputHandle();
  const secondHandle = createChatAttachmentInputHandle();
  mountInputs({}, "agent-chat__composer-shell", firstHandle, first);
  mountInputs({}, "new-session-page__composer", secondHandle, second);
  flush();
  const firstFile = first.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
  const firstPhoto = first.querySelector<HTMLInputElement>(".agent-chat__photo-input")!;
  const secondFile = second.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
  const firstTrigger = first.querySelector<HTMLButtonElement>(".attachment-menu")!;
  const secondTrigger = second.querySelector<HTMLButtonElement>(".attachment-menu")!;
  const rectangle = vi
    .spyOn(firstTrigger, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(12, 24, 36, 48));
  vi.spyOn(secondTrigger, "getBoundingClientRect").mockReturnValue(new DOMRect(50, 60, 70, 80));
  const clickFirst = vi.spyOn(firstFile, "click").mockImplementation(() => undefined);
  const clickPhoto = vi.spyOn(firstPhoto, "click").mockImplementation(() => undefined);
  const clickSecond = vi.spyOn(secondFile, "click").mockImplementation(() => undefined);

  firstHandle.open("file");
  expect(clickFirst).toHaveBeenCalledOnce();
  expect(clickSecond).not.toHaveBeenCalled();
  expect(firstFile.style.left).toBe("12px");
  expect(firstFile.style.top).toBe("24px");
  expect(firstFile.style.width).toBe("36px");
  expect(firstFile.style.height).toBe("48px");

  rectangle.mockReturnValue(new DOMRect(90, 100, 110, 120));
  firstHandle.openNative("photo");
  expect(clickPhoto).toHaveBeenCalledOnce();
  expect(firstPhoto.style.left).toBe("90px");
  expect(firstPhoto.style.top).toBe("100px");
  expect(firstPhoto.style.width).toBe("110px");
  expect(firstPhoto.style.height).toBe("120px");
  expect(rectangle).toHaveBeenCalledTimes(2);

  secondHandle.open("file");
  expect(clickSecond).toHaveBeenCalledOnce();
  expect(secondFile.style.left).toBe("50px");
  expect(secondFile.style.top).toBe("60px");

  cleanupSolid();
  firstHandle.open("file");
  firstHandle.openNative("photo");
  secondHandle.open("file");
  expect(clickFirst).toHaveBeenCalledOnce();
  expect(clickPhoto).toHaveBeenCalledOnce();
  expect(clickSecond).toHaveBeenCalledOnce();
});
