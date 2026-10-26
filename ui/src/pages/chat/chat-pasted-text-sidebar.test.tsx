/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  createAttachmentSidebarHarness,
  renderAttachmentHarness,
} from "./chat-attachment-picker.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createPasteEvent, renderChatView } from "./chat-view.test-helpers.ts";
import type { ChatAttachmentControlsProps } from "./components/chat-attachment-controls.types.ts";
import { ComposerPastedText } from "./components/chat-composer-pasted-text.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const restoreSelector = ".chat-attachment-text-action";
const iconSelector = ".chat-attachment-file__icon svg";
beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function pastedText(text: string) {
  let attachments: ChatAttachment[] = [];
  const props = {
    getAttachments: () => attachments,
    onAttachmentsChange: (next: ChatAttachment[]) => {
      attachments = next;
    },
    onDraftChange: vi.fn(),
    onOpenSidebar: vi.fn(),
  };
  const producer = renderAttachmentHarness(props.getAttachments, props.onAttachmentsChange);
  producer.querySelector("textarea")!.dispatchEvent(createPasteEvent(text));
  const attachment = expectDefined(attachments[0], "pasted attachment");
  onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
  return { props, attachment };
}

function button(container: Element, selector: string) {
  return expectDefined(container.querySelector<HTMLButtonElement>(selector), selector);
}

it.each(["restore", "preview"] as const)(
  "handles the pasted file card %s action independently",
  async (action) => {
    const text = "  Preserve indentation 🦞\n" + "x".repeat(1100);
    const { props, attachment } = pastedText(text);
    const sidebar = action === "preview" ? createAttachmentSidebarHarness() : undefined;
    const onOpenSidebar = sidebar?.open ?? props.onOpenSidebar;
    const { onDraftChange } = props;
    const container = renderChatView({
      ...props,
      attachments: props.getAttachments(),
      getDraft: () => "Newer draft",
      onOpenSidebar,
    });
    document.body.append(container);
    const target = action === "restore" ? "openclaw-chat-pasted-text button" : iconSelector;
    await waitForFast(() => expect(container.querySelector(target)).not.toBeNull());
    if (action === "restore") {
      const restore = button(container, `.chat-attachments-preview ${restoreSelector}`);
      restore.click();
      restore.click();
      expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("Newer draft\n\n" + text);
      expect(props.getAttachments()).toEqual([]);
      expect(onOpenSidebar).not.toHaveBeenCalled();
    } else {
      const open = container.querySelector(".chat-attachment-file__open");
      expect(open?.closest("openclaw-tooltip")).toBeNull();
      container
        .querySelector(iconSelector)!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onOpenSidebar).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: "attachment", plainText: true, mimeType: "text/plain" }),
      );
      const sidebarRestore = button(sidebar!.container, restoreSelector);
      expect(sidebarRestore.textContent?.trim()).toBe("Show in text field");
      sidebar!.container.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click();
      expect(props.getAttachments()).toEqual([]);
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      expect(onDraftChange).not.toHaveBeenCalled();
    }
  },
);

it.each(["disabled", "removed", "aborted"] as const)(
  "guards the in-card restore action after %s",
  async (state) => {
    const { props: source, attachment } = pastedText("Preserve this paste " + "x".repeat(1100));
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
