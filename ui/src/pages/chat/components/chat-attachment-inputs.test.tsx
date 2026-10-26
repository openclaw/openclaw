/* @vitest-environment jsdom */

import { onSettled } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { createChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import { makeMenu } from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import "./chat-camera-capture.tsx";

let host: HTMLDivElement;
let restoreDialog: () => void;

const input = (kind: string, container: Element = host) =>
  container.querySelector<HTMLInputElement>(`.agent-chat__${kind}-input`)!;
const clickSpy = (element: HTMLElement) =>
  vi.spyOn(element, "click").mockImplementation(() => undefined);
const anchorRect = (element: HTMLElement, x: number, y: number, width: number, height: number) =>
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, width, height));
function expectRect(element: HTMLElement, ...values: number[]) {
  const properties = ["left", "top", "width", "height"].slice(0, values.length);
  expect(properties.map((key) => element.style.getPropertyValue(key))).toEqual(
    values.map((value) => `${value}px`),
  );
}

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

function mountInputs(initial: ChatAttachmentControlsProps, composerClass?: string, menu = false) {
  const container = composerClass ? host.appendChild(document.createElement("div")) : host;
  container.className = composerClass ?? "";
  const handle = createChatAttachmentInputHandle();
  const trigger = document.createElement("button");
  trigger.addEventListener("click", () => handle.open("camera"));
  const view = mountSolid(
    (props: ChatAttachmentControlsProps) => {
      onSettled(() => handle.bindAnchor(trigger));
      return (
        <>
          <ChatAttachmentInputs {...props} inputHandle={handle} />
          {menu && (
            <ChatComposerPlusMenu
              menu={makeMenu({ open: true, attachments: props, inputHandle: handle })}
            />
          )}
        </>
      );
    },
    initial,
    container,
  );
  container.append(trigger);
  const camera = container.querySelector("openclaw-chat-camera-capture")!;
  const draw = async (next: ChatAttachmentControlsProps) => {
    view.update(next);
    await camera.updateComplete;
  };
  return {
    camera,
    draw,
    handle,
    trigger,
    file: input("file", container),
    photo: input("photo", container),
  };
}

it.each([false, true])(
  "selects existing media through the real menu and draft owner (imagesOnly=%s)",
  async (imagesOnly) => {
    const draft = createAttachmentDraft({
      maxBytes: 1024,
      maxImageBytes: 1024,
      maxBatchBytes: 2048,
    });
    onTestFinished(draft.dispose);
    const props = { ...draft.props, imagesOnly };
    mountInputs(props, undefined, true);
    const kind = imagesOnly ? "photo" : "media";
    await waitForSolid(() => expect(host.querySelector(`[data-value="${kind}"]`)).not.toBeNull());
    const action = host.querySelector<HTMLButtonElement>(`[data-value="${kind}"]`)!;
    expect(action.textContent).toBe(imagesOnly ? "Photo" : "Photos & videos");
    const picker = input(kind);
    const open = clickSpy(picker);
    action.click();
    expect(open).toHaveBeenCalledOnce();
    expect(picker).toMatchObject({
      accept: imagesOnly ? "image/*" : "image/*,video/*",
      multiple: true,
    });
    expect(picker.hasAttribute("capture")).toBe(false);
    const select = (files: File[]) => {
      Object.defineProperty(picker, "files", { configurable: true, value: files });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    };
    select([
      new File(["image"], "still.png", { type: "image/png" }),
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
    ]);
    await waitForSolid(() => expect(draft.reads.pendingReads).toBe(0));
    expect(draft.attachments().map(({ fileName }) => fileName)).toEqual(
      imagesOnly ? ["still.png"] : ["still.png", "clip.mp4"],
    );
    select([]);
    expect(draft.attachments()).toHaveLength(imagesOnly ? 1 : 2);
  },
);

it("retains the lazy camera host and forwards current availability and read scope", async () => {
  const props = { readSignal: new AbortController().signal };
  const { draw, camera } = mountInputs(props);
  await camera.updateComplete;
  expect(camera.childElementCount).toBe(0);
  const readSignal = new AbortController().signal;
  for (const [next, disabled] of [
    [{ ...props, draft: "A new draft" }, false],
    [{ ...props, disabled: true }, true],
    [{ ...props, cameraActive: false }, true],
    [{ readSignal }, false],
  ] as const) {
    await draw(next);
    expect(host.querySelector("openclaw-chat-camera-capture")).toBe(camera);
    expect(camera).toMatchObject({ disabled, readSignal: next.readSignal, childElementCount: 0 });
  }
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
        "Android Chrome/153.0.0.0 Mobile Safari/537.36",
      );
    }
    const initialProps = { disabled: false };
    const { draw, camera, trigger, photo: photoInput } = mountInputs(initialProps, composerClass);
    const dialog = () => camera.querySelector("openclaw-modal-dialog");
    const nativeInput = input("camera");
    expect(nativeInput).toMatchObject({ accept: "image/*", multiple: false });
    expect(nativeInput.getAttribute("capture")).toBe("environment");
    expect(photoInput).toMatchObject({ accept: "image/*", multiple: true });
    expect(photoInput.hasAttribute("capture")).toBe(false);
    expect(input("file").hasAttribute("accept")).toBe(false);
    await camera.updateComplete;
    // A callback retained from the earlier render would now reject this picker.
    initialProps.disabled = true;
    await draw({ ...initialProps, disabled: false });
    const clickNative = clickSpy(nativeInput);
    const rectangle = anchorRect(trigger, 12, 24, 36, 48);
    trigger.click();
    await camera.updateComplete;
    if (android) {
      expect(clickNative).toHaveBeenCalledOnce();
      expect(dialog()).toBeNull();
    } else {
      expect(clickNative).not.toHaveBeenCalled();
      const nativeButton = [...camera.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Use device camera",
      )!;
      rectangle.mockReturnValue(new DOMRect(90, 100, 110, 120));
      nativeButton.click();
      expect(clickNative).toHaveBeenCalledOnce();
      await camera.updateComplete;
    }
    expectRect(nativeInput, android ? 12 : 90, android ? 24 : 100);
    for (const unavailable of [
      { disabled: true },
      { cameraActive: false },
      { readSignal: AbortSignal.abort() },
    ]) {
      await draw({ ...initialProps, disabled: false, ...unavailable });
      trigger.click();
      expect(clickNative).toHaveBeenCalledOnce();
      expect(dialog()).toBeNull();
    }
  },
);

it("keeps mounted picker refs scoped and refreshes their anchor rectangle on every activation", () => {
  const first = mountInputs({}, "agent-chat__composer-shell");
  const second = mountInputs({}, "new-session-page__composer");
  const rectangle = anchorRect(first.trigger, 12, 24, 36, 48);
  anchorRect(second.trigger, 50, 60, 70, 80);
  const clickFirst = clickSpy(first.file);
  const clickPhoto = clickSpy(first.photo);
  const clickSecond = clickSpy(second.file);

  first.handle.open("file");
  expect(clickFirst).toHaveBeenCalledOnce();
  expect(clickSecond).not.toHaveBeenCalled();
  expectRect(first.file, 12, 24, 36, 48);

  rectangle.mockReturnValue(new DOMRect(90, 100, 110, 120));
  first.handle.openNative("photo");
  expect(clickPhoto).toHaveBeenCalledOnce();
  expectRect(first.photo, 90, 100, 110, 120);

  second.handle.open("file");
  expect(clickSecond).toHaveBeenCalledOnce();
  expectRect(second.file, 50, 60);

  cleanupSolid();
  first.handle.open("file");
  first.handle.openNative("photo");
  second.handle.open("file");
  expect(clickFirst).toHaveBeenCalledOnce();
  expect(clickPhoto).toHaveBeenCalledOnce();
  expect(clickSecond).toHaveBeenCalledOnce();
});
