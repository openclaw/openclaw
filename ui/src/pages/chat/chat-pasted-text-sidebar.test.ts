/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  createAttachmentSidebarHarness,
  renderAttachmentHarness,
} from "./chat-attachment-picker.test-support.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createPasteEvent, renderChatView } from "./chat-view.test-helpers.ts";
import type { ChatAttachmentControlsProps } from "./components/chat-attachment-controls.types.ts";
import { renderComposerPastedText } from "./components/chat-composer-pasted-text.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
});
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
});

it.each(["restore", "preview"] as const)(
  "handles the pasted file card %s action independently",
  async (action) => {
    let attachments: ChatAttachment[] = [];
    const producer = renderAttachmentHarness(
      () => attachments,
      (next) => {
        attachments = next;
      },
    );
    const text =
      (action === "restore" ? "  Preserve indentation 🦞\n" : "Review this paste ") +
      "x".repeat(1100);
    producer.querySelector("textarea")!.dispatchEvent(createPasteEvent(text));
    const attachment = expectDefined(attachments[0], "pasted attachment");
    onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
    const sidebar = action === "preview" ? createAttachmentSidebarHarness() : undefined;
    const onOpenSidebar = sidebar?.open ?? vi.fn();
    const onDraftChange = vi.fn();
    const container = renderChatView({
      attachments,
      getAttachments: () => attachments,
      getDraft: () => "Newer draft",
      onAttachmentsChange: (next) => {
        attachments = next;
      },
      onDraftChange,
      onOpenSidebar,
    });
    document.body.append(container);
    await waitForFast(() =>
      expect(
        container.querySelector(
          action === "restore"
            ? "openclaw-chat-pasted-text button"
            : ".chat-attachment-file__icon svg",
        ),
      ).not.toBeNull(),
    );
    if (action === "restore") {
      const restore = expectDefined(
        container.querySelector<HTMLButtonElement>(
          ".chat-attachments-preview .chat-attachment-text-action",
        ),
        "inline Show in text field action",
      );
      const card = expectDefined(
        restore.closest(".chat-attachment-thumb--file"),
        "pasted file card",
      );
      expect(card.classList.contains("chat-selection-annotations__chip")).toBe(false);
      expect(restore.closest(".chat-attachment-file__body")).not.toBeNull();
      expect(
        restore.parentElement?.firstElementChild?.classList.contains("chat-attachment-file__name"),
      ).toBe(true);
      expect(restore.closest("a, button button, [role=button]")).toBeNull();
      expect(card.querySelector(".chat-attachment-file__icon")).not.toBeNull();
      restore.click();
      restore.click();
      expect(onDraftChange).toHaveBeenCalledTimes(1);
      expect(onDraftChange).toHaveBeenCalledWith("Newer draft\n\n" + text);
      expect(attachments).toEqual([]);
      expect(onOpenSidebar).not.toHaveBeenCalled();
    } else {
      expect(
        container.querySelector(".chat-attachment-file__open")?.closest("openclaw-tooltip"),
      ).toBeNull();
      container
        .querySelector(".chat-attachment-file__icon svg")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onOpenSidebar).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: "attachment", plainText: true, mimeType: "text/plain" }),
      );
      expect(
        sidebar!.container.querySelector(".chat-attachment-text-action")?.textContent?.trim(),
      ).toBe("Show in text field");
      sidebar!.container.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click();
      expect(attachments).toEqual([]);
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      expect(onDraftChange).not.toHaveBeenCalled();
    }
  },
);

it.each(["disabled", "removed", "aborted"] as const)(
  "guards the in-card restore action after %s",
  async (state) => {
    let attachments: ChatAttachment[] = [];
    const producer = renderAttachmentHarness(
      () => attachments,
      (next) => {
        attachments = next;
      },
    );
    producer
      .querySelector("textarea")!
      .dispatchEvent(createPasteEvent("Preserve this paste " + "x".repeat(1100)));
    const attachment = expectDefined(attachments[0], "pasted attachment");
    onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
    const controller = new AbortController();
    const onDraftChange = vi.fn();
    const onAttachmentsChange = vi.fn();
    const onOpenSidebar = vi.fn();
    const props: ChatAttachmentControlsProps = {
      attachments,
      getAttachments: () => attachments,
      readSignal: controller.signal,
      disabled: state === "disabled",
      onDraftChange,
      onAttachmentsChange,
      onOpenSidebar,
    };
    const container = document.createElement("div");
    render(renderComposerPastedText(attachment, props), container);
    document.body.append(container);
    await waitForFast(() =>
      expect(container.querySelector(".chat-attachment-text-action")).not.toBeNull(),
    );
    if (state === "removed") {
      attachments = [];
    }
    if (state === "aborted") {
      controller.abort();
    }
    const action = expectDefined(
      container.querySelector<HTMLButtonElement>(".chat-attachment-text-action"),
      "restore action",
    );
    expect(action.disabled).toBe(state === "disabled");
    action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const remove = expectDefined(
      container.querySelector<HTMLButtonElement>(".chat-attachment-remove"),
      "remove pasted text action",
    );
    expect(remove.disabled).toBe(state === "disabled");
    remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(onOpenSidebar).not.toHaveBeenCalled();
    expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
  },
);
