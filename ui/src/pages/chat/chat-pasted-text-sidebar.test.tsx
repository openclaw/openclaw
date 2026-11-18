/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { createAttachmentSidebarHarness } from "./chat-attachment-picker.test-support.ts";
import type { ChatAttachmentControlsProps } from "./components/chat-attachment-controls.types.ts";
import { ComposerPastedText } from "./components/chat-composer-pasted-text.tsx";

const restoreSelector = ".chat-attachment-text-action";
const iconSelector = ".chat-attachment-file__icon svg";

function pastedText() {
  const attachment = registerChatAttachmentPayload({
    attachment: { id: "paste", mimeType: "text/plain", fileName: "paste.txt", origin: "paste" },
    dataUrl: "data:text/plain,Preserve%20this%20paste",
    file: new File(["Preserve this paste"], "paste.txt", { type: "text/plain" }),
  });
  let attachments = [attachment];
  const props = {
    getAttachments: () => attachments,
    onAttachmentsChange: (next: ChatAttachment[]) => {
      attachments = next;
    },
    onDraftChange: vi.fn(),
    onOpenSidebar: vi.fn(),
  };
  onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
  return { props, attachment };
}

function button(container: Element, selector: string) {
  return expectDefined(container.querySelector<HTMLButtonElement>(selector), selector);
}

it("opens pasted text from its icon and removes it from the sidebar without changing the draft", async () => {
  const { props, attachment } = pastedText();
  const sidebar = createAttachmentSidebarHarness();
  const controls = {
    ...props,
    attachments: props.getAttachments(),
    onOpenSidebar: sidebar.open,
  };
  const { container } = mountSolid(() => (
    <ComposerPastedText attachment={attachment} controls={controls} />
  ));
  await waitForFast(() => expect(container.querySelector(iconSelector)).not.toBeNull());
  container.querySelector(iconSelector)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(button(sidebar.container, restoreSelector).textContent?.trim()).toBe("Show in text field");
  button(sidebar.container, "button[aria-label^='Remove']").click();
  expect(props.getAttachments()).toEqual([]);
  expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  expect(props.onDraftChange).not.toHaveBeenCalled();
});

it.each(["disabled", "removed", "aborted"] as const)(
  "guards the in-card restore action after %s",
  async (state) => {
    const { props: source, attachment } = pastedText();
    const controller = new AbortController();
    const onAttachmentsChange = vi.fn();
    const { onDraftChange, onOpenSidebar } = source;
    const props: ChatAttachmentControlsProps = {
      ...source,
      attachments: source.getAttachments(),
      readSignal: controller.signal,
      disabled: state === "disabled",
      onAttachmentsChange,
    };
    const { container } = mountSolid(() => (
      <ComposerPastedText attachment={attachment} controls={props} />
    ));
    await waitForFast(() => expect(container.querySelector(restoreSelector)).not.toBeNull());
    if (state === "removed") {
      source.onAttachmentsChange([]);
    }
    if (state === "aborted") {
      controller.abort();
    }
    for (const selector of [restoreSelector, ".chat-attachment-remove"]) {
      const action = button(container, selector);
      expect(action.disabled).toBe(state === "disabled");
      action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    for (const callback of [onDraftChange, onAttachmentsChange, onOpenSidebar]) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
  },
);
