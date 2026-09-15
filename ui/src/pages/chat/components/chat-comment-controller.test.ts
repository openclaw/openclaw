import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import "./chat-comment-controller.ts";
import { renderChatSelectionAnnotations } from "./chat-selection-annotations.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";

const payloads = new Set<string>();

afterEach(() => {
  document.body.replaceChildren();
  for (const id of payloads) {
    releaseChatAttachmentPayload(id);
  }
  payloads.clear();
});

async function mountComments() {
  const attachment = createChatSelectionAttachment({
    text: "Selected passage",
    comment: "Original comment",
    sessionKey: "agent:main:main",
    start: 0,
    end: 16,
  })!;
  let attachments: ChatAttachment[] = [attachment];
  payloads.add(attachment.id);
  const signalOwner = new AbortController();
  const card = document.createElement("section");
  card.className = "card chat";
  const controller = document.createElement("openclaw-chat-comment-controller") as HTMLElement & {
    props: ChatAttachmentControlsProps;
    sessionKey: string;
    presented: boolean;
    updateComplete: Promise<unknown>;
  };
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
  card.append(controller, composer);
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
    signalOwner,
    edit,
    input,
    save,
    attachments: () => attachments,
  };
}

describe("comment actions outside the transcript", () => {
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
  });

  it.each(["disabled", "hidden", "aborted"] as const)(
    "retires an open editor and rejects its detached Save control when %s",
    async (reason) => {
      const fixture = await mountComments();
      fixture.edit();
      fixture.input()!.value = "Retired edit";
      const save = fixture.save();
      if (reason === "disabled") {
        fixture.controller.props = { ...fixture.controller.props, disabled: true };
      } else if (reason === "hidden") {
        fixture.controller.presented = false;
      } else {
        fixture.signalOwner.abort();
      }
      await fixture.controller.updateComplete;
      expect(fixture.input()).toBeNull();
      save.click();
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
});
