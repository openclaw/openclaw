import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { render, nothing } from "lit";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ComposerEditor } from "../../components/composer-editor.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController } from "./composer-controller.ts";
import { renderNewSessionDraftComposer } from "./draft-composer.ts";
import { NewSessionModelControl } from "./model-control.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function createDragEvent(type: string, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
  return event;
}

it.each(["owner", "tile"] as const)(
  "keeps loading slots ordered across batches and cancels through %s",
  async (cancellation) => {
    const readers: FileReader[] = [];
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      readers.push(this);
    });
    const container = document.createElement("div");
    const attachmentDraft = new NewSessionAttachmentDraft(
      () => redraw(),
      () => {},
    );
    const textareaController = new NewSessionComposerTextareaController();
    const modelControl = new NewSessionModelControl(() => {});
    const redraw = () =>
      render(
        renderNewSessionDraftComposer({
          agentId: "main",
          attachmentDraft,
          canSubmit: attachmentDraft.pendingReads === 0,
          context: undefined,
          draftOwnerKey: "attachments",
          isCatalogTarget: true,
          message: "Keep this draft",
          modelControl,
          requiresModifier: false,
          requestUpdate: redraw,
          submitting: false,
          textareaController,
          onInput: () => {},
          onSubmit: () => {},
        }),
        container,
      );
    onTestFinished(() => {
      attachmentDraft.reset({ release: true });
      textareaController.disconnect();
      render(nothing, container);
    });
    redraw();
    const composer = expectDefined(
      container.querySelector(".new-session-page__composer"),
      "new-session composer",
    );
    const status = () => container.querySelector(".chat-attachments-status");
    composer.dispatchEvent(
      createDragEvent("drop", [new File(["first"], "first.txt"), new File(["bad"], "bad.txt")]),
    );
    composer.dispatchEvent(createDragEvent("drop", [new File(["second"], "second.txt")]));
    expect(attachmentDraft.pendingReads).toBe(3);
    expect(
      container.querySelector(".new-session-page__start-submit")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(status()?.textContent).toContain("Preparing 3 attachments");
    expect(status()?.classList.contains("sr-only")).toBe(true);
    expect(status()?.querySelector(".btn__spinner")).toBeNull();
    const tiles = [...container.querySelectorAll(".chat-attachment-thumb")];
    expect(tiles).toHaveLength(3);
    expect(tiles.every((tile) => tile.getAttribute("aria-busy") === "true")).toBe(true);
    readers[0]?.dispatchEvent(
      new ProgressEvent("progress", { lengthComputable: true, loaded: 5, total: 10 }),
    );
    expect(
      tiles[0]?.querySelector<HTMLElement>(".chat-attachment-loading > span")?.style.transform,
    ).toBe("scaleX(0.5)");
    expect(
      tiles[1]?.querySelector(".chat-attachment-loading")?.getAttribute("data-indeterminate"),
    ).toBe("true");
    // Complete the later batch first. Its tile and payload must keep admission order.
    Object.defineProperty(readers[2], "result", { value: "data:text/plain;base64,c2Vjb25k" });
    readers[2]?.dispatchEvent(new ProgressEvent("load"));
    await waitForFast(() =>
      expect(attachmentDraft.attachments.map(({ fileName }) => fileName)).toEqual(["second.txt"]),
    );
    tiles.forEach((tile, index) =>
      expect(container.querySelectorAll(".chat-attachment-thumb")[index]).toBe(tile),
    );
    Object.defineProperty(readers[0], "result", { value: "data:text/plain;base64,Zmlyc3Q=" });
    readers[0]?.dispatchEvent(new ProgressEvent("load"));
    await waitForFast(() =>
      expect(attachmentDraft.attachments.map(({ fileName }) => fileName)).toEqual([
        "first.txt",
        "second.txt",
      ]),
    );
    expect(status()?.textContent).toContain("Preparing 1 attachment");
    readers[1]?.dispatchEvent(new ProgressEvent("error"));
    await waitForFast(() => expect(attachmentDraft.pendingReads).toBe(0));
    tiles.forEach((tile, index) =>
      expect(container.querySelectorAll(".chat-attachment-thumb")[index]).toBe(tile),
    );
    expect(
      tiles[1]?.querySelector('.chat-attachment-error[role="img"]')?.getAttribute("aria-label"),
    ).toContain("bad.txt");
    expect(status()?.textContent?.trim()).toBe("");

    composer.dispatchEvent(createDragEvent("drop", [new File(["held"], "held.txt")]));
    expect(attachmentDraft.pendingReads).toBe(1);
    if (cancellation === "owner") {
      attachmentDraft.abortReads();
    } else {
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove held.txt"]')?.click();
    }
    expect(
      container.querySelector(".new-session-page__start-submit")?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(status()?.textContent?.trim()).toBe("");
    Object.defineProperty(readers[3], "result", { value: "data:text/plain;base64,aGVsZA==" });
    readers[3]?.dispatchEvent(new ProgressEvent("load"));
    await Promise.resolve();
    expect(attachmentDraft.pendingReads).toBe(0);
    expect(attachmentDraft.attachments.map(({ fileName }) => fileName)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(container.querySelector('button[aria-label="Remove held.txt"]')).toBeNull();
    expect(container.querySelector<ComposerEditor>("openclaw-composer-editor")?.value).toBe(
      "Keep this draft",
    );
  },
);
