import { expectDefined } from "@openclaw/normalization-core";
import { createComponent, createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { waitForRenderedModalDialog } from "../../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { createComposerContainer } from "../chat-composer.test-support.ts";
import {
  createChatProps,
  disposeChatView,
  renderChatPropsInto,
} from "../chat-view.test-helpers.ts";
import { chatAttachmentFromDataUrl } from "./chat-attachments.ts";
import { ImageRedactionButton } from "./chat-image-redaction-button.tsx";

function original() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const context = expectDefined(canvas.getContext("2d"), "fixture context");
  context.fillStyle = "orange";
  context.fillRect(0, 0, 32, 32);
  const data = canvas.toDataURL("image/png");
  const attachment = expectDefined(
    chatAttachmentFromDataUrl(data, "private.png", undefined, 0),
    "source",
  );
  onTestFinished(() => {
    document.querySelector("openclaw-modal-dialog")?.dispatchEvent(new CustomEvent("modal-cancel"));
    releaseChatAttachmentPayload(attachment.id);
  });
  return { attachment, data };
}

async function open(container: ParentNode) {
  const button = await vi.waitFor(() =>
    expectDefined(
      container.querySelector<HTMLButtonElement>(".chat-attachment-redact"),
      "redact action",
    ),
  );
  button.click();
  const { modal } = await waitForRenderedModalDialog(document.body);
  return modal;
}

async function cover(modal: HTMLElement) {
  const canvas = expectDefined(modal.querySelector("canvas"), "editor canvas");
  const bounds = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      pointerId: 1,
      button: 0,
      clientX: bounds.left,
      clientY: bounds.top,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      pointerId: 1,
      clientX: bounds.right,
      clientY: bounds.bottom,
    }),
  );
  await vi.waitFor(() => expect(modal.textContent).toContain("Covered areas: 1"));
}

it("retains editable areas and original custody when replacement admission rejects Apply", async () => {
  const { attachment, data } = original();
  const changed = vi.fn();
  const view = mountSolid(() =>
    createComponent(ImageRedactionButton, {
      attachment,
      controls: {
        attachments: [attachment],
        attachmentLimits: { maxBytes: 1, maxImageBytes: 1 },
        onAttachmentsChange: changed,
      },
    }),
  );
  onTestFinished(view.unmount);
  const modal = await open(view.container);
  await cover(modal);
  expectDefined(
    [...modal.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply redaction",
    ),
    "Apply",
  ).click();
  await Promise.resolve();
  expect(modal.isConnected).toBe(true);
  expect(modal.textContent).toContain("Covered areas: 1");
  expect(changed).not.toHaveBeenCalled();
  expect(getChatAttachmentDataUrl(attachment)).toBe(data);
  expectDefined(
    [...modal.querySelectorAll("button")].find((button) => button.textContent === "Undo last area"),
    "Undo",
  ).click();
  await vi.waitFor(() => expect(modal.textContent).toContain("Covered areas: 0"));
});

it("retires an open editor on live main presentation change while render props remain parked", async () => {
  const { attachment, data } = original();
  const owner = new EventTarget();
  let presented = true;
  const changed = vi.fn();
  const container = createComposerContainer();
  document.body.append(container);
  onTestFinished(() => {
    disposeChatView(container);
    container.remove();
  });
  const props = createChatProps({
    attachments: [attachment],
    onAttachmentsChange: changed,
    cameraActive: true,
    presented: { owner, isPresented: () => presented },
  });
  renderChatPropsInto(container, props);
  const modal = await open(container);
  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  await vi.waitFor(() => expect(modal.isConnected).toBe(false));
  expect(changed).not.toHaveBeenCalled();
  expect(getChatAttachmentDataUrl(attachment)).toBe(data);
});

it("keeps edited work through temporary Sidechat upload ineligibility", async () => {
  const { attachment, data } = original();
  const [disabled, setDisabled] = createSignal(false);
  const changed = vi.fn();
  const view = mountSolid(() =>
    createComponent(ImageRedactionButton, {
      attachment,
      get controls() {
        return { attachments: [attachment], disabled: disabled(), onAttachmentsChange: changed };
      },
    }),
  );
  onTestFinished(view.unmount);
  const modal = await open(view.container);
  await cover(modal);
  const apply = expectDefined(
    [...modal.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply redaction",
    ),
    "Apply",
  );
  setDisabled(true);
  await vi.waitFor(() => expect(apply.disabled).toBe(true));
  expect(modal.isConnected).toBe(true);
  expect(modal.textContent).toContain("Covered areas: 1");
  setDisabled(false);
  await vi.waitFor(() => expect(apply.disabled).toBe(false));
  expect(modal.textContent).toContain("Covered areas: 1");
  expect(changed).not.toHaveBeenCalled();
  expect(getChatAttachmentDataUrl(attachment)).toBe(data);
});
