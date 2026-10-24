// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import * as toast from "../../lib/toast.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  createAttachmentSidebarHarness,
  renderAttachmentHarness,
  renderSettledPastedTextAttachment,
} from "./chat-attachment-picker.test-support.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import {
  createChatProps,
  createPasteEvent,
  disposeChatView,
  getComposerTextarea,
  renderChatPropsInto,
} from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.tsx";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.tsx";

const payloads: ChatAttachment[] = [];

afterEach(() => {
  releaseChatAttachmentPayloads(payloads.splice(0));
  resetChatViewState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderChatView(overrides: Partial<ChatProps>) {
  const container = createComposerContainer();
  renderChatPropsInto(
    container,
    createChatProps({
      ...overrides,
      onAttachmentsChange: (attachments) => {
        payloads.push(...attachments);
        overrides.onAttachmentsChange?.(attachments);
      },
    }),
  );
  return container;
}

const find = (container: Element, selector: string) =>
  expectDefined(container.querySelector<HTMLElement>(selector), selector);
const click = (container: Element, selector: string) =>
  find(container, selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
function finishRead(reader: FileReader, value: string, configurable = false) {
  Object.defineProperty(reader, "result", { configurable, value });
  reader.dispatchEvent(new ProgressEvent("load"));
}
function readingProps(reads: ChatAttachmentReadLifecycle) {
  const readSignal = reads.readSignal;
  return {
    attachmentReads: reads,
    readSignal,
    pendingAttachmentReads: reads.pendingReads,
    getPendingAttachmentReads: () => reads.pendingReads,
    onPendingReadsChange: (delta: 1 | -1) => reads.updatePending(readSignal, delta),
  };
}
const sendState = (button: HTMLButtonElement) => [
  button.disabled,
  button.getAttribute("aria-busy"),
];

function deferFileReaders() {
  const readers: FileReader[] = [];
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    readers.push(this);
  });
  return readers;
}

function attachFile(container: Element, file: File, entry: "clipboard" | "file picker" | "drop") {
  if (entry === "clipboard") {
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { items: [{ type: file.type, getAsFile: () => file }], getData: () => "" },
    });
    getComposerTextarea(container).dispatchEvent(paste);
  } else if (entry === "file picker") {
    const input = expectDefined(
      container.querySelector<HTMLInputElement>(".agent-chat__file-input"),
      "file input",
    );
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"] } });
    find(container, "section.chat").dispatchEvent(drop);
  }
}

describe("chat attachment paste", () => {
  it("removes upload controls and rejects file paste/drop while preserving plain text paste", async () => {
    const uploadConfig = createApplicationConfigCapability({ resourceBasePath: "" });
    const onAttachmentsChange = vi.fn();
    const container = renderChatView({ uploadConfig, onAttachmentsChange });
    expect(container.querySelector("input[type=file]")).not.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ uploadsEnabled: false })),
    );
    await uploadConfig.refresh();
    const disabled = renderChatView({ uploadConfig, onAttachmentsChange });
    expect(disabled.querySelector("input[type=file]")).toBeNull();
    expect(disabled.querySelector(".agent-chat__attach-menu-option")).toBeNull();
    const textarea = getComposerTextarea(disabled);
    const textPaste = createPasteEvent("ordinary text ".repeat(200));
    textarea.dispatchEvent(textPaste);
    expect(textPaste.defaultPrevented).toBe(false);
    const imagePaste = createPasteEvent("data:image/png;base64,YWJj");
    textarea.dispatchEvent(imagePaste);
    expect(imagePaste.defaultPrevented).toBe(true);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [new File(["proof"], "proof.txt")],
      },
    });
    disabled.querySelector("section.chat")!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    // Retained enabled render handlers also consume the current policy.
    getComposerTextarea(container).dispatchEvent(createPasteEvent("data:image/png;base64,YWJj"));
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });

  it("preserves pasted-text presentation and restore behavior across handoff", async () => {
    let attachments: ChatAttachment[] = [];
    const producer = renderAttachmentHarness(
      () => attachments,
      (next) => {
        attachments = next;
      },
    );
    const pastedText = `First words from a remounted paste ${"x".repeat(1100)}`;
    getComposerTextarea(producer).dispatchEvent(createPasteEvent(pastedText));
    const original = expectDefined(attachments[0], "pasted attachment");
    const originalDataUrl = getChatAttachmentDataUrl(original);

    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    onTestFinished(() => handoff.dispose());
    const owner = {} as GatewayBrowserClient;
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments,
      fallbacks: {},
    });
    attachments = expectDefined(
      handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" }),
      "restored attachments",
    ).attachments;

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toBe(original);
    expect(getChatAttachmentDataUrl(original)).toBe(originalDataUrl);

    const onAttachmentsChange = vi.fn();
    const onDraftChange = vi.fn();
    const sidebar = createAttachmentSidebarHarness();
    const remounted = await renderSettledPastedTextAttachment({
      onOpenSidebar: sidebar.open,
      attachments,
      getAttachments: () => attachments,
      draft: "intro",
      getDraft: () => "intro",
      onAttachmentsChange,
      onDraftChange,
    });
    expect(remounted.querySelector(".chat-attachment-file__open")?.textContent).toContain(
      "First words from a remounted p…",
    );
    expect(attachments[0]?.origin).toBe("paste");
    click(remounted, ".chat-attachment-file__open");
    click(sidebar.container, ".chat-attachment-text-action");

    expect(onAttachmentsChange).toHaveBeenCalledWith([]);
    expect(onDraftChange).toHaveBeenCalledWith(`intro\n\n${pastedText}`);
    expect(getChatAttachmentDataUrl(original)).toBeNull();
  });

  it.each(["supported", "invalid"] as const)("handles %s pasted image bytes", (kind) => {
    const onAttachmentsChange = vi.fn<(attachments: ChatAttachment[]) => void>();
    const container = renderChatView({ onAttachmentsChange });
    const base64 =
      kind === "supported" ? Buffer.alloc(4 * 1024 * 1024, 0xab).toString("base64") : "AA$A";
    const dataUrl = `data:image/png;base64,${base64}`;
    const allowed = getComposerTextarea(container).dispatchEvent(createPasteEvent(dataUrl, []));
    if (kind === "invalid") {
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      return;
    }
    expect(allowed).toBe(false);
    const attachments = expectDefined(onAttachmentsChange.mock.calls[0]?.[0], "pasted attachments");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.sizeBytes).toBe(4 * 1024 * 1024);
    expect(getChatAttachmentDataUrl(expectDefined(attachments[0], "pasted image"))).toBe(dataUrl);
  });
});

describe("chat attachment reading", () => {
  it.each(["uploads disabled", "session aborted"] as const)(
    "rejects an in-flight read after %s",
    async (outcome) => {
      const notify = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const base = createApplicationConfigCapability({ resourceBasePath: "" });
      const uploadConfig = { ...base, current: { ...base.current, uploadsEnabled: true } };
      const readers = deferFileReaders();
      const reads = new ChatAttachmentReadLifecycle(() => undefined);
      const readSignal = reads.readSignal;
      onTestFinished(() => reads.abortReads());
      const onAttachmentsChange = vi.fn();
      const aborted = outcome === "session aborted";
      const props = {
        uploadConfig,
        sessionKey: "agent:main:session-a",
        draft: "Keep this file with the message",
        ...readingProps(reads),
        onAttachmentsChange,
      };
      const container = renderChatView(props);
      attachFile(
        container,
        new File(
          [aborted ? "private session A" : "attachment proof"],
          aborted ? "private.png" : "proof.png",
          { type: "image/png" },
        ),
        aborted ? "drop" : "file picker",
      );
      expect(readers).toHaveLength(1);
      expect(reads.pendingReads).toBe(1);
      if (aborted) {
        reads.abortReads();
        await Promise.resolve();
        await Promise.resolve();
        expect(readSignal.aborted).toBe(true);
        expect(reads.readSignal).not.toBe(readSignal);
      } else {
        uploadConfig.current.uploadsEnabled = false;
        finishRead(
          expectDefined(readers[0], "pending attachment reader"),
          "data:image/png;base64,YWJj",
        );
        await Promise.resolve();
        const failed = renderChatView(props);
        expect(failed.querySelectorAll(".chat-attachment-thumb")).toHaveLength(0);
        expect(failed.querySelector(".chat-attachment-failures")).toBeNull();
        expect(getComposerTextarea(failed).value).toBe(props.draft);
        expect(notify).toHaveBeenCalledExactlyOnceWith({
          message: "File and image uploads are disabled.",
          placement: "top-center",
          severity: "error",
        });
      }
      expect(reads.pendingReads).toBe(0);
      expect(reads.project([])).toHaveLength(0);
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      if (aborted) {
        expect(notify).not.toHaveBeenCalled();
      }
    },
  );

  it("waits for an in-flight clipboard attachment before accepting an immediate send", async () => {
    const readers = deferFileReaders();
    const container = createComposerContainer();
    const file = new File(["attachment proof"], "proof.png", { type: "image/png" });
    const draft = "Send the attachment with this message";
    let attachments: ChatAttachment[] = [];
    const onSend = vi.fn(() => {
      expect(attachments.map((attachment) => attachment.fileName)).toEqual(["proof.png"]);
    });
    const redraw = () => {
      renderChatPropsInto(
        container,
        createChatProps({
          attachments,
          draft,
          getAttachments: () => attachments,
          getDraft: () => draft,
          onAttachmentsChange: (next) => {
            attachments = next;
          },
          onSend,
          ...readingProps(reads),
        }),
      );
    };
    const reads = new ChatAttachmentReadLifecycle(redraw);
    onTestFinished(() => {
      reads.abortReads();
      releaseChatAttachmentPayloads(attachments);
      disposeChatView(container);
    });
    redraw();

    attachFile(container, file, "clipboard");

    expect(readers).toHaveLength(1);
    expect(reads.pendingReads).toBe(1);
    const status = container.querySelector(".chat-attachments-status");
    expect(status?.textContent).toContain("Preparing 1 attachment");
    expect(container.querySelectorAll('.chat-attachment-thumb[aria-busy="true"]')).toHaveLength(1);
    const pendingTile = container.querySelector(".chat-attachment-thumb");
    expect(status?.querySelector(".btn__spinner")).toBeNull();
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.classList.contains("sr-only")).toBe(true);
    expect(getComposerTextarea(container).disabled).toBe(false);
    const sendButton = () =>
      expectDefined(
        container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "send button",
      );
    const send = sendButton();
    expect(sendState(send)).toEqual([true, "true"]);
    expect(send.closest("openclaw-tooltip")?.content).toBe("Preparing attachments…");
    getComposerTextarea(container).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(onSend).not.toHaveBeenCalled();

    const reader = expectDefined(readers[0], "deferred attachment reader");
    reader.dispatchEvent(
      new ProgressEvent("progress", { lengthComputable: true, loaded: 1, total: 2 }),
    );
    expect(container.querySelector(".chat-attachment-thumb")).toBe(pendingTile);
    expect(
      pendingTile?.querySelector<HTMLElement>(".chat-attachment-loading > span")?.style.transform,
    ).toBe("scaleX(0.5)");
    finishRead(reader, `data:image/png;base64,${btoa("attachment proof")}`, true);

    await waitForFast(() => {
      expect(reads.pendingReads).toBe(0);
      expect(attachments.map((attachment) => attachment.fileName)).toEqual(["proof.png"]);
    });
    expect(container.querySelector(".chat-attachment-thumb")).toBe(pendingTile);
    expect(pendingTile?.getAttribute("aria-busy")).toBe("false");
    const readySend = sendButton();
    expect(sendState(readySend)).toEqual([false, "false"]);
    expect(container.querySelector(".chat-attachments-status")?.textContent?.trim()).toBe("");
    readySend.click();
    expect(onSend).toHaveBeenCalledOnce();
  });
});
