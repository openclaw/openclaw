/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render, nothing } from "lit";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
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

it("shows one preparation status across mixed read batches and clears it on cancellation", async () => {
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
  expect(attachmentDraft.pendingReads).toBe(2);
  expect(
    container.querySelector(".new-session-page__start-submit")?.getAttribute("aria-busy"),
  ).toBe("true");
  expect(status()?.textContent).toContain("Preparing attachments");
  expect(status()?.classList.contains("sr-only")).toBe(false);
  expect(
    [...container.querySelectorAll('[role="status"]')].filter((node) =>
      /Reading attachment|Preparing attachments/.test(node.textContent ?? ""),
    ),
  ).toHaveLength(1);
  Object.defineProperty(readers[0], "result", { value: "data:text/plain;base64,Zmlyc3Q=" });
  readers[0]?.dispatchEvent(new ProgressEvent("load"));
  readers[1]?.dispatchEvent(new ProgressEvent("error"));
  await waitForFast(() =>
    expect(attachmentDraft.attachments.map(({ fileName }) => fileName)).toEqual(["first.txt"]),
  );
  expect(attachmentDraft.pendingReads).toBe(1);
  expect(status()?.textContent).toContain("Preparing attachments");
  attachmentDraft.abortReads();
  expect(
    container.querySelector(".new-session-page__start-submit")?.getAttribute("aria-busy"),
  ).toBe("false");
  expect(status()?.textContent?.trim()).toBe("");
  Object.defineProperty(readers[2], "result", { value: "data:text/plain;base64,c2Vjb25k" });
  readers[2]?.dispatchEvent(new ProgressEvent("load"));
  await Promise.resolve();
  expect(attachmentDraft.pendingReads).toBe(0);
  expect(attachmentDraft.attachments.map(({ fileName }) => fileName)).toEqual(["first.txt"]);
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this draft");
});
