import { nothing, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import "../../../lib/toast.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { createChatProps } from "../chat-view.test-helpers.ts";
import { renderChat } from "../chat-view.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import "./chat-comment-controller.ts";
import { renderChatSelectionAnnotations } from "./chat-selection-annotations.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";

const payloads = new Set<string>();
type CommentControllerElement = HTMLElement & {
  props: ChatAttachmentControlsProps;
  sessionKey: string;
  disabled: boolean;
  presented: boolean;
  updateComplete: Promise<unknown>;
  performUpdate(): void;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  for (const id of payloads) {
    releaseChatAttachmentPayload(id);
  }
  payloads.clear();
});

async function mountComments(additional: ChatAttachment[] = []) {
  const attachment = createChatSelectionAttachment(
    {
      text: "Selected passage",
      comment: "Original comment",
      sessionKey: "agent:main:main",
      start: 0,
      end: 16,
    },
    {},
    0,
  )!;
  let attachments: ChatAttachment[] = [attachment, ...additional];
  for (const item of attachments) {
    payloads.add(item.id);
  }
  const signalOwner = new AbortController();
  const card = document.createElement("section");
  card.className = "chat";
  const controller = document.createElement(
    "openclaw-chat-comment-controller",
  ) as CommentControllerElement;
  const composer = document.createElement("div");
  const props: ChatAttachmentControlsProps = {
    attachments,
    getAttachments: () => attachments,
    readSignal: signalOwner.signal,
    onAttachmentsChange: (next) => {
      attachments = next;
      for (const item of next) {
        payloads.add(item.id);
      }
      controller.props = { ...props, attachments };
      render(renderChatSelectionAnnotations(controller.props), composer);
    },
  };
  controller.props = props;
  controller.sessionKey = "agent:main:main";
  render(renderChatSelectionAnnotations(props), composer);
  const toast = document.createElement("openclaw-toast-host");
  card.append(controller, composer, toast);
  document.body.append(card);
  await controller.updateComplete;
  const edit = () =>
    composer.querySelector<HTMLButtonElement>('button[aria-label="Edit comment 1"]')!.click();
  const input = () =>
    document.querySelector<HTMLTextAreaElement>(".chat-annotation-editor textarea");
  const save = () =>
    document.querySelector<HTMLButtonElement>(".chat-annotation-editor__controls .primary")!;
  return {
    attachment,
    controller,
    composer,
    card,
    toast,
    signalOwner,
    edit,
    input,
    save,
    attachments: () => attachments,
  };
}

describe("comment actions outside the transcript", () => {
  it("keeps the controller idle across unchanged chat renders and updates when composition is disabled", async () => {
    const container = document.createElement("div");
    onTestFinished(() => {
      render(nothing, container);
    });
    document.body.append(container);
    const props = createChatProps({ loading: true });
    render(renderChat(props), container);
    const controller = container.querySelector<CommentControllerElement>(
      "openclaw-chat-comment-controller",
    )!;
    await controller.updateComplete;
    const updates = vi.spyOn(controller, "performUpdate");

    render(renderChat(props), container);
    await controller.updateComplete;
    expect(updates).not.toHaveBeenCalled();

    render(renderChat({ ...props, draft: "A new draft" }), container);
    await controller.updateComplete;
    expect(updates).not.toHaveBeenCalled();

    render(renderChat({ ...props, canSend: false }), container);
    await controller.updateComplete;
    expect(updates).toHaveBeenCalledOnce();
  });

  it("edits and deletes staged comments without a built-in transcript, releasing replaced payloads", async () => {
    const fixture = await mountComments();
    fixture.edit();
    expect(fixture.input()?.value).toBe("Original comment");
    fixture.input()!.value = "Revised comment";
    fixture.save().click();
    await fixture.controller.updateComplete;
    expect(fixture.attachments()[0]?.selectionAnnotation?.comment).toBe("Revised comment");
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBeNull();
    fixture.composer
      .querySelector<HTMLButtonElement>('button[aria-label="Delete comment"]')!
      .click();
    expect(fixture.attachments()).toEqual([]);
    expect(fixture.input()).toBeNull();
    await fixture.toast.updateComplete;
    expect(fixture.toast.querySelector("[role=status]")).toBeNull();
  });

  it("keeps overflowing edits correctable and counts only the replacement toward the frame budget", async () => {
    const file: ChatAttachment = {
      id: "retained-file",
      mimeType: "text/plain",
      fileName: "notes.txt",
      dataUrl: "data:text/plain;base64,bm90ZXM=",
    };
    const fixture = await mountComments([file]);
    const originalPayload = getChatAttachmentDataUrl(fixture.attachment)!;
    const originalBytes = Buffer.from(originalPayload.split(",")[1]!, "base64").byteLength;
    fixture.controller.props = {
      ...fixture.controller.props,
      attachmentLimits: {
        maxBytes: 10_000,
        maxImageBytes: 10_000,
        maxBatchBytes: originalBytes + 5,
      },
    };
    await fixture.controller.updateComplete;
    fixture.edit();
    fixture.input()!.value = "Original comment!";
    fixture.save().click();
    await fixture.controller.updateComplete;
    await fixture.toast.updateComplete;
    expect(fixture.input()?.value).toBe("Original comment!");
    expect(fixture.attachments()).toEqual([fixture.attachment, file]);
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBe(originalPayload);
    expect(fixture.toast.textContent).toContain("Too large to send: selection-comment.txt");

    fixture.input()!.value = "Replaced comment";
    fixture.save().click();
    await fixture.controller.updateComplete;
    expect(fixture.input()).toBeNull();
    expect(fixture.attachments()).toMatchObject([
      { selectionAnnotation: { comment: "Replaced comment" } },
      file,
    ]);
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBeNull();
    expect(getChatAttachmentDataUrl(file)).toBe(file.dataUrl);
  });

  it("removes all current-session comments while retaining other attachments and their payloads", async () => {
    const createComment = (sessionKey: string) =>
      createChatSelectionAttachment(
        {
          text: "Another passage",
          comment: "Keep its context",
          sessionKey,
          start: 0,
          end: 15,
        },
        {},
        0,
      )!;
    const second = createComment("agent:main:main");
    const otherSession = createComment("agent:main:other");
    const file: ChatAttachment = {
      id: "ordinary-file",
      mimeType: "text/plain",
      fileName: "notes.txt",
      dataUrl: "data:text/plain;base64,bm90ZXM=",
    };
    const fixture = await mountComments([second, file, otherSession]);
    fixture.edit();
    fixture.composer
      .querySelector<HTMLButtonElement>('button[aria-label="Remove all comments"]')!
      .click();
    expect(fixture.attachments()).toEqual([file, otherSession]);
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBeNull();
    expect(getChatAttachmentDataUrl(second)).toBeNull();
    await fixture.toast.updateComplete;
    expect(fixture.toast.querySelector("[role=status]")).toBeNull();
    expect(getChatAttachmentDataUrl(otherSession)).not.toBeNull();
    expect(fixture.input()).toBeNull();
  });

  it.each(["disabled", "hidden", "aborted"] as const)(
    "retires an open editor and rejects its detached Save control when %s",
    async (reason) => {
      const fixture = await mountComments();
      fixture.edit();
      fixture.input()!.value = "Retired edit";
      const save = fixture.save();
      if (reason === "disabled") {
        fixture.controller.disabled = true;
      } else if (reason === "hidden") {
        fixture.controller.presented = false;
      } else {
        fixture.signalOwner.abort();
      }
      await fixture.controller.updateComplete;
      expect(fixture.input()).toBeNull();
      save.click();
      fixture.composer.dispatchEvent(
        new CustomEvent("openclaw-comment-action", {
          bubbles: true,
          composed: true,
          detail: { action: "delete-all" },
        }),
      );
      expect(fixture.attachments()[0]?.selectionAnnotation?.comment).toBe("Original comment");
    },
  );

  it("restores abort ownership when the controller reconnects with unchanged props", async () => {
    const fixture = await mountComments();
    fixture.controller.remove();
    fixture.card.prepend(fixture.controller);
    await fixture.controller.updateComplete;
    fixture.edit();
    expect(fixture.input()).not.toBeNull();
    fixture.signalOwner.abort();
    expect(fixture.input()).toBeNull();
  });

  it("keeps same-scope editors open and transfers abort ownership when the read signal changes", async () => {
    const fixture = await mountComments();
    fixture.edit();
    const updates = vi.spyOn(fixture.controller, "performUpdate");
    fixture.controller.props = { ...fixture.controller.props, draft: "A new draft" };
    await fixture.controller.updateComplete;
    expect(updates).not.toHaveBeenCalled();
    expect(fixture.input()).not.toBeNull();

    const nextOwner = new AbortController();
    fixture.controller.props = { ...fixture.controller.props, readSignal: nextOwner.signal };
    await fixture.controller.updateComplete;
    expect(updates).toHaveBeenCalledOnce();
    expect(fixture.input()).toBeNull();
    fixture.edit();
    fixture.signalOwner.abort();
    expect(fixture.input()).not.toBeNull();
    nextOwner.abort();
    expect(fixture.input()).toBeNull();
  });
});
