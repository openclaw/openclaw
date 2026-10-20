/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal, flush } from "solid-js";
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

it("retains the focused restore action when the same attachment is refreshed", () => {
  const attachment: ChatAttachment = {
    id: "focused-paste",
    mimeType: "text/plain",
    origin: "paste",
    dataUrl: "data:text/plain;base64,cGFzdGU=",
  };
  const controls: ChatAttachmentControlsProps = {
    attachments: [attachment],
    onDraftChange: vi.fn(),
  };
  let updateControls!: (next: ChatAttachmentControlsProps) => void;
  const view = mountSolid(() => {
    const [current, setCurrent] = createSignal(controls);
    updateControls = setCurrent;
    return <ComposerPastedText attachment={current().attachments![0]!} controls={current()} />;
  });
  flush();
  const restore = view.getByRole("button", { name: "Show in text field" });
  restore.focus();
  updateControls({ ...controls, attachments: [{ ...attachment }] });
  flush();
  expect(view.getByRole("button", { name: "Show in text field" })).toBe(restore);
  expect(document.activeElement).toBe(restore);
});

it.each(["restore", "preview"] as const)(
  "handles the pasted file card %s action independently",
  async (action) => {
    const text =
      (action === "restore" ? "  Preserve indentation 🦞\n" : "Review this paste ") +
      "x".repeat(1100);
    const f = pastedText(text);
    const sidebar = action === "preview" ? createAttachmentSidebarHarness() : undefined;
    const onOpenSidebar = sidebar?.open ?? f.props.onOpenSidebar;
    const { onDraftChange } = f.props;
    const container = renderChatView({
      ...f.props,
      attachments: f.props.getAttachments(),
      getDraft: () => "Newer draft",
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
      const restore = button(container, ".chat-attachments-preview .chat-attachment-text-action");
      const card = expectDefined(
        restore.closest(".chat-attachment-thumb--file"),
        "pasted file card",
      );
      expect(card.classList.contains("chat-selection-annotations__chip")).toBe(false);
      const body = restore.closest(".chat-attachment-file__body");
      expect(body?.firstElementChild?.classList.contains("chat-attachment-file__name")).toBe(true);
      expect(restore.closest("a, button button, [role=button]")).toBeNull();
      expect(card.querySelector(".chat-attachment-file__icon")).not.toBeNull();
      restore.click();
      restore.click();
      expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("Newer draft\n\n" + text);
      expect(f.props.getAttachments()).toEqual([]);
      expect(onOpenSidebar).not.toHaveBeenCalled();
    } else {
      const open = container.querySelector(".chat-attachment-file__open");
      expect(open?.closest("openclaw-tooltip")).toBeNull();
      container
        .querySelector(".chat-attachment-file__icon svg")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onOpenSidebar).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: "attachment", plainText: true, mimeType: "text/plain" }),
      );
      const sidebarRestore = button(sidebar!.container, ".chat-attachment-text-action");
      expect(sidebarRestore.textContent?.trim()).toBe("Show in text field");
      sidebar!.container.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click();
      expect(f.props.getAttachments()).toEqual([]);
      expect(getChatAttachmentDataUrl(f.attachment)).toBeNull();
      expect(onDraftChange).not.toHaveBeenCalled();
    }
  },
);

it.each(["disabled", "removed", "aborted"] as const)(
  "guards the in-card restore action after %s",
  async (state) => {
    const f = pastedText("Preserve this paste " + "x".repeat(1100));
    const { attachment } = f;
    const controller = new AbortController();
    const onAttachmentsChange = vi.fn();
    const { onDraftChange, onOpenSidebar } = f.props;
    const props: ChatAttachmentControlsProps = {
      ...f.props,
      attachments: f.props.getAttachments(),
      readSignal: controller.signal,
      disabled: state === "disabled",
      onAttachmentsChange,
    };
    const { container } = mountSolid(() => (
      <ComposerPastedText attachment={attachment} controls={props} />
    ));
    await waitForFast(() =>
      expect(container.querySelector(".chat-attachment-text-action")).not.toBeNull(),
    );
    if (state === "removed") {
      f.props.onAttachmentsChange([]);
    }
    if (state === "aborted") {
      controller.abort();
    }
    for (const selector of [".chat-attachment-text-action", ".chat-attachment-remove"]) {
      const action = button(container, selector);
      expect(action.disabled).toBe(state === "disabled");
      action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect([
      onDraftChange.mock.calls,
      onAttachmentsChange.mock.calls,
      onOpenSidebar.mock.calls,
    ]).toEqual([[], [], []]);
    expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
  },
);
