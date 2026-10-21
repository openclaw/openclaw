import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "../../../lib/toast-host.tsx";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { createComposerContainer } from "../chat-composer.test-support.ts";
import { createChatProps, renderChatPropsInto } from "../chat-view.test-helpers.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatCommentController } from "./chat-comment-controller.ts";
import { ChatSelectionAnnotations, type ChatCommentAction } from "./chat-selection-annotations.tsx";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";
import { removeChatSelectionPopup } from "./chat-selection-popup.tsx";

const payloads = new Set<string>();

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  removeChatSelectionPopup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const controllerContainer = document.createElement("div");
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
      update({ props: { ...props, attachments } });
      setAnnotationProps({ ...props, attachments });
    },
  };
  const [view, setView] = createSignal<Parameters<typeof ChatCommentController>[0]>({
    props,
    sessionKey: "agent:main:main",
    paneId: "",
    presented: true,
    disabled: false,
  });
  const update = (patch: Partial<Parameters<typeof ChatCommentController>[0]>) =>
    setView((current) => ({ ...current, ...patch }));
  const [annotationProps, setAnnotationProps] = createSignal(props);
  mountSolid(() => <ChatSelectionAnnotations {...annotationProps()} />, { container: composer });
  const toast = document.createElement("openclaw-toast-host");
  card.append(controllerContainer, composer, toast);
  mountSolid(() => <ChatCommentController {...view()} />, { container: controllerContainer });
  const controller = controllerContainer.querySelector<HTMLElement>(
    "openclaw-chat-comment-controller",
  )!;
  document.body.append(card);
  flush();
  const edit = () =>
    composer.querySelector<HTMLButtonElement>('button[aria-label="Edit comment 1"]')!.click();
  const input = () =>
    document.querySelector<HTMLTextAreaElement>(".chat-annotation-editor textarea");
  const save = () =>
    document.querySelector<HTMLButtonElement>(".chat-annotation-editor__controls .primary")!;
  return {
    attachment,
    controller,
    view,
    update,
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
  it("focuses the composer after deleting the last comment when the transcript is detached", async () => {
    const container = createComposerContainer();
    document.body.append(container);
    const onAttachmentsChange = vi.fn();
    renderChatPropsInto(
      container,
      createChatProps({
        attachments: [
          {
            id: "detached-transcript-comment",
            mimeType: "text/plain",
            selectionAnnotation: {
              text: "Selected passage",
              comment: "Original comment",
              sessionKey: "main",
              start: 0,
              end: 16,
            },
          },
        ],
        onAttachmentsChange,
      }),
    );
    flush();
    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox > textarea",
    )!;
    const focus = vi.spyOn(textarea, "focus");
    container.querySelector(".chat-thread")!.remove();
    await waitForSolid(() =>
      expect(container.querySelector('button[aria-label="Delete comment"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete comment"]')!.click();
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("anchors preview edit actions to their owned trigger", async () => {
    const fixture = await mountComments();
    const trigger = fixture.composer.querySelector<HTMLButtonElement>(
      ".chat-selection-annotations__trigger",
    )!;
    let action: ChatCommentAction | undefined;
    fixture.composer.addEventListener("openclaw-comment-action", (event) => {
      action = (event as CustomEvent<ChatCommentAction>).detail;
    });

    fixture.edit();

    expect(action).toMatchObject({ id: fixture.attachment.id, action: "edit" });
    expect(action?.anchor).toBe(trigger);
    expect(fixture.input()?.value).toBe("Original comment");
  });

  it.each(["open", "closed", "disconnected"] as const)(
    "restores focus to the next comment delete button only while its preview remains open (%s)",
    async (presentation) => {
      const second: ChatAttachment = {
        id: "second-comment",
        mimeType: "text/plain",
        selectionAnnotation: {
          text: "Another passage",
          comment: "Another comment",
          sessionKey: "agent:main:main",
          start: 0,
          end: 15,
        },
      };
      const fixture = await mountComments([second]);
      const preview = fixture.composer.querySelector<HTMLElement>(".chat-comment-preview")!;
      const nextDelete = fixture.composer.querySelector<HTMLButtonElement>(
        '[data-comment-delete="second-comment"]',
      )!;
      const focus = vi.spyOn(nextDelete, "focus");
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        frames.push(callback),
      );
      preview.setAttribute("open", "");

      fixture.composer.querySelector<HTMLButtonElement>("[data-comment-delete]")!.click();
      flush();
      expect(fixture.attachments()).toEqual([second]);
      if (presentation === "closed") {
        preview.removeAttribute("open");
      } else if (presentation === "disconnected") {
        fixture.composer.remove();
      }
      for (const frame of frames.splice(0)) {
        frame(0);
      }

      expect(focus).toHaveBeenCalledTimes(presentation === "open" ? 1 : 0);
      if (presentation === "open") {
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      }
    },
  );

  it("keeps an editor across draft renders and retires it when composition is disabled", async () => {
    const container = createComposerContainer();
    document.body.append(container);
    const attachment: ChatAttachment = {
      id: "rendered-comment",
      mimeType: "text/plain",
      selectionAnnotation: {
        text: "Selected passage",
        comment: "In-progress edit",
        sessionKey: "main",
        start: 0,
        end: 16,
      },
    };
    const props = createChatProps({ loading: true, attachments: [attachment] });
    renderChatPropsInto(container, props);
    const controller = container.querySelector<HTMLElement>("openclaw-chat-comment-controller")!;
    flush();
    controller.dispatchEvent(
      new CustomEvent("openclaw-comment-action", {
        bubbles: true,
        detail: { action: "edit", id: attachment.id },
      }),
    );
    const editor = document.querySelector<HTMLTextAreaElement>(".chat-annotation-editor textarea")!;
    expect(editor.value).toBe("In-progress edit");
    editor.value = "A draft that must survive";

    renderChatPropsInto(container, props);
    flush();
    expect(document.querySelector(".chat-annotation-editor textarea")).toBe(editor);

    renderChatPropsInto(container, { ...props, draft: "A new draft" });
    flush();
    expect(editor.value).toBe("A draft that must survive");
    expect(document.querySelector(".chat-annotation-editor textarea")).toBe(editor);

    renderChatPropsInto(container, { ...props, canSend: false });
    flush();
    expect(document.querySelector(".chat-annotation-editor")).toBeNull();
  });

  it("edits and deletes staged comments without a built-in transcript, releasing replaced payloads", async () => {
    const fixture = await mountComments();
    fixture.edit();
    expect(fixture.input()?.value).toBe("Original comment");
    fixture.input()!.value = "Revised comment";
    fixture.save().click();
    flush();
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
    fixture.update({
      props: {
        ...fixture.view().props,
        attachmentLimits: {
          maxBytes: 10_000,
          maxImageBytes: 10_000,
          maxBatchBytes: originalBytes + 5,
        },
      },
    });
    flush();
    fixture.edit();
    fixture.input()!.value = "Original comment!";
    fixture.save().click();
    flush();
    expect(fixture.input()?.value).toBe("Original comment!");
    expect(fixture.attachments()).toEqual([fixture.attachment, file]);
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBe(originalPayload);
    await waitForSolid(() =>
      expect(fixture.toast.querySelector(".app-toast__message")?.textContent).toBe(
        "File too large. Try a smaller file.",
      ),
    );

    fixture.input()!.value = "Replaced comment";
    fixture.save().click();
    flush();
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
        fixture.update({ disabled: true });
      } else if (reason === "hidden") {
        fixture.update({ presented: false });
      } else {
        fixture.signalOwner.abort();
      }
      flush();
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
    flush();
    fixture.edit();
    expect(fixture.input()).not.toBeNull();
    fixture.signalOwner.abort();
    expect(fixture.input()).toBeNull();
  });

  it("keeps same-scope editors open and transfers abort ownership when the read signal changes", async () => {
    const fixture = await mountComments();
    fixture.edit();
    fixture.update({ props: { ...fixture.view().props, draft: "A new draft" } });
    flush();
    expect(fixture.input()).not.toBeNull();

    const nextOwner = new AbortController();
    fixture.update({ props: { ...fixture.view().props, readSignal: nextOwner.signal } });
    flush();
    expect(fixture.input()).toBeNull();
    fixture.edit();
    fixture.signalOwner.abort();
    expect(fixture.input()).not.toBeNull();
    nextOwner.abort();
    expect(fixture.input()).toBeNull();
  });
});
