/* @vitest-environment jsdom */

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

let restoreDialog: () => void;

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Android Chrome/153.0.0.0 Mobile Safari/537.36",
  );
});

afterEach(() => {
  cleanupSolid();
  restoreDialog();
  vi.restoreAllMocks();
});

function draft() {
  const owner = createAttachmentDraft({ maxBytes: 1024, maxImageBytes: 1024, maxBatchBytes: 2048 });
  onTestFinished(owner.dispose);
  return owner;
}

function mountCapture(props: ChatAttachmentControlsProps) {
  const inputHandle = createChatAttachmentInputHandle();
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  return mountSolid(
    (current: ChatAttachmentControlsProps) => (
      <>
        <ChatAttachmentInputs {...current} inputHandle={inputHandle} />
        <ChatComposerPlusMenu menu={makeMenu({ open: true, attachments: current, inputHandle })} />
      </>
    ),
    props,
    container,
  );
}

function select(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

it.each(["camera", "camera-video"])(
  "does not attach a late %s result to a replacement draft or after cancellation",
  async (kind) => {
    const original = draft();
    const replacement = draft();
    const view = mountCapture(original.props);
    const input = view.container.querySelector<HTMLInputElement>(`.agent-chat__${kind}-input`);
    expect(input).not.toBeNull();
    input!.click();
    original.reads.abortReads();
    view.update(replacement.props);
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-chat-camera-capture")!.readSignal).toBe(
        replacement.props.readSignal,
      ),
    );
    const file = new File(["capture"], kind === "camera" ? "capture.jpg" : "capture.mp4", {
      type: kind === "camera" ? "image/jpeg" : "video/mp4",
    });
    select(input!, file);
    expect(replacement.reads.pendingReads).toBe(0);
    expect(replacement.attachments()).toEqual([]);
    expect(original.attachments()).toEqual([]);

    input!.click();
    input!.dispatchEvent(new Event("cancel"));
    select(input!, file);
    expect(replacement.reads.pendingReads).toBe(0);
    expect(replacement.attachments()).toEqual([]);

    input!.click();
    view.dispose();
    select(input!, file);
    expect(replacement.reads.pendingReads).toBe(0);
    expect(replacement.attachments()).toEqual([]);
  },
);

it("keeps image-only composers photo-only even if a video input returns a file", async () => {
  const owner = draft();
  const view = mountCapture({ ...owner.props, imagesOnly: true });
  await waitForSolid(() =>
    expect(view.container.querySelector('[data-value="camera"]')).not.toBeNull(),
  );
  expect(view.container.querySelector('[data-value="camera-video"]')).toBeNull();
  const input = view.container.querySelector<HTMLInputElement>(".agent-chat__camera-video-input")!;
  expect(input.disabled).toBe(true);
  input.click();
  select(input, new File(["clip"], "capture.mp4", { type: "video/mp4" }));
  expect(owner.reads.pendingReads).toBe(0);
  expect(owner.attachments()).toEqual([]);
});
