import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { stubResizeObserver } from "../../../test-helpers/resize-observer.ts";
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
const annotation = (
  comment = "Original comment",
  sessionKey = "agent:main:main",
  text = "Selected passage",
) => ({ text, comment, sessionKey, start: 0, end: text.length });
const comment = (id: string, value = annotation()): ChatAttachment => ({
  id,
  mimeType: "text/plain",
  selectionAnnotation: value,
});
const file = (id: string): ChatAttachment => ({
  id,
  mimeType: "text/plain",
  fileName: "notes.txt",
  dataUrl: "data:text/plain;base64,bm90ZXM=",
});
const button = (root: ParentNode, selector: string) =>
  root.querySelector<HTMLButtonElement>(selector)!;
const input = () => document.querySelector<HTMLTextAreaElement>(".chat-annotation-editor textarea");
const dispatchAction = (root: HTMLElement, detail: ChatCommentAction) =>
  root.dispatchEvent(
    new CustomEvent("openclaw-comment-action", { bubbles: true, composed: true, detail }),
  );

function mountChat(
  attachments: ChatAttachment[],
  extra: Parameters<typeof createChatProps>[0] = {},
) {
  const container = createComposerContainer();
  document.body.append(container);
  const props = createChatProps({ attachments, ...extra });
  const render = (patch: Partial<typeof props> = {}) => {
    renderChatPropsInto(container, { ...props, ...patch });
    flush();
  };
  render();
  return { container, render };
}

beforeEach(() => {
  stubResizeObserver();
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
  const attachment = createChatSelectionAttachment(annotation(), {}, 0)!;
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
  const updateProps = (patch: Partial<ChatAttachmentControlsProps>) => {
    update({ props: { ...view().props, ...patch } });
    flush();
  };
  mountSolid(() => <ChatSelectionAnnotations {...view().props} />, { container: composer });
  const toast = document.createElement("openclaw-toast-host");
  card.append(controllerContainer, composer, toast);
  mountSolid(() => <ChatCommentController {...view()} />, { container: controllerContainer });
  const controller = controllerContainer.querySelector<HTMLElement>(
    "openclaw-chat-comment-controller",
  )!;
  document.body.append(card);
  flush();
  const edit = async () => {
    button(composer, 'button[aria-label="Edit comment 1"]').click();
    await waitForSolid(() => expect(input()).not.toBeNull());
  };
  const save = () => button(document, ".chat-annotation-editor__controls .primary");
  const replace = (text: string) => {
    input()!.value = text;
    save().click();
    flush();
  };
  return {
    attachment,
    controller,
    update,
    updateProps,
    composer,
    card,
    toast,
    signalOwner,
    edit,
    input,
    save,
    replace,
    attachments: () => attachments,
  };
}

describe("comment actions outside the transcript", () => {
  it("focuses the composer after deleting the last comment when the transcript is detached", async () => {
    const onAttachmentsChange = vi.fn();
    const { container } = mountChat(
      [comment("detached-transcript-comment", annotation("Original comment", "main"))],
      { onAttachmentsChange },
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox > textarea",
    )!;
    const focus = vi.spyOn(textarea, "focus");
    container.querySelector(".chat-thread")!.remove();
    await waitForSolid(() =>
      expect(container.querySelector('button[aria-label="Delete comment"]')).not.toBeNull(),
    );
    button(container, 'button[aria-label="Delete comment"]').click();
    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it.each(["open", "closed", "disconnected"] as const)(
    "restores focus to the next comment delete button only while its preview remains open (%s)",
    async (presentation) => {
      const second = comment(
        "second-comment",
        annotation("Another comment", "agent:main:main", "Another passage"),
      );
      const fixture = await mountComments([second]);
      const preview = fixture.composer.querySelector<HTMLElement>(".chat-comment-preview")!;
      const nextDelete = button(fixture.composer, '[data-comment-delete="second-comment"]');
      const focus = vi.spyOn(nextDelete, "focus");
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        frames.push(callback),
      );
      preview.setAttribute("open", "");

      button(fixture.composer, "[data-comment-delete]").click();
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
    const attachment = comment("rendered-comment", annotation("In-progress edit", "main"));
    const { container, render } = mountChat([attachment], { loading: true });
    const controller = container.querySelector<HTMLElement>("openclaw-chat-comment-controller")!;
    dispatchAction(controller, { action: "edit", id: attachment.id });
    const editor = await waitForSolid(() => {
      expect(input()).not.toBeNull();
      return input()!;
    });
    expect(editor.value).toBe("In-progress edit");
    editor.value = "A draft that must survive";

    render();
    expect(input()).toBe(editor);

    render({ draft: "A new draft" });
    expect(editor.value).toBe("A draft that must survive");
    expect(input()).toBe(editor);

    render({ canSend: false });
    expect(document.querySelector(".chat-annotation-editor")).toBeNull();
  });

  it("keeps overflowing edits correctable and counts only the replacement toward the frame budget", async () => {
    const retainedFile = file("retained-file");
    const fixture = await mountComments([retainedFile]);
    const originalPayload = getChatAttachmentDataUrl(fixture.attachment)!;
    const originalBytes = Buffer.from(originalPayload.split(",")[1]!, "base64").byteLength;
    fixture.updateProps({
      attachmentLimits: {
        maxBytes: 10_000,
        maxImageBytes: 10_000,
        maxBatchBytes: originalBytes + 5,
      },
    });
    let action: ChatCommentAction | undefined;
    fixture.composer.addEventListener("openclaw-comment-action", (event) => {
      action = (event as CustomEvent<ChatCommentAction>).detail;
    });
    await fixture.edit();
    expect(action).toMatchObject({ id: fixture.attachment.id, action: "edit" });
    expect(action?.anchor).toBe(button(fixture.composer, ".chat-selection-annotations__trigger"));
    expect(fixture.input()?.value).toBe("Original comment");
    fixture.replace("Original comment!");
    expect(fixture.input()?.value).toBe("Original comment!");
    expect(fixture.attachments()).toEqual([fixture.attachment, retainedFile]);
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBe(originalPayload);
    await waitForSolid(() =>
      expect(fixture.toast.querySelector(".app-toast__message")?.textContent).toBe(
        "File too large. Try a smaller file.",
      ),
    );

    fixture.replace("Replaced comment");
    expect(fixture.input()).toBeNull();
    expect(fixture.attachments()).toMatchObject([
      { selectionAnnotation: { comment: "Replaced comment" } },
      retainedFile,
    ]);
    expect(getChatAttachmentDataUrl(fixture.attachment)).toBeNull();
    expect(getChatAttachmentDataUrl(retainedFile)).toBe(retainedFile.dataUrl);
  });

  it("removes all current-session comments while retaining other attachments and their payloads", async () => {
    const createComment = (sessionKey: string) =>
      createChatSelectionAttachment(
        annotation("Keep its context", sessionKey, "Another passage"),
        {},
        0,
      )!;
    const second = createComment("agent:main:main");
    const otherSession = createComment("agent:main:other");
    const ordinaryFile = file("ordinary-file");
    const fixture = await mountComments([second, ordinaryFile, otherSession]);
    await fixture.edit();
    button(fixture.composer, 'button[aria-label="Remove all comments"]').click();
    expect(fixture.attachments()).toEqual([ordinaryFile, otherSession]);
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
      await fixture.edit();
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
      dispatchAction(fixture.composer, { action: "delete-all" });
      expect(fixture.attachments()[0]?.selectionAnnotation?.comment).toBe("Original comment");
    },
  );

  it("restores abort ownership when the controller reconnects with unchanged props", async () => {
    const fixture = await mountComments();
    fixture.controller.remove();
    fixture.card.prepend(fixture.controller);
    flush();
    await fixture.edit();
    fixture.signalOwner.abort();
    expect(fixture.input()).toBeNull();
  });

  it("transfers editor abort ownership when the read signal changes", async () => {
    const fixture = await mountComments();
    await fixture.edit();
    const nextOwner = new AbortController();
    fixture.updateProps({ readSignal: nextOwner.signal });
    expect(fixture.input()).toBeNull();
    await fixture.edit();
    fixture.signalOwner.abort();
    expect(fixture.input()).not.toBeNull();
    nextOwner.abort();
    expect(fixture.input()).toBeNull();
  });
});
