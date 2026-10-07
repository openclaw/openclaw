// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
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
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, createPasteEvent, requireElement } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.ts";

const payloads: ChatAttachment[] = [];

afterEach(() => {
  releaseChatAttachmentPayloads(payloads.splice(0));
  resetChatViewState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]>) {
  const container = document.createElement("div");
  render(
    renderChat(
      createChatProps({
        ...overrides,
        onAttachmentsChange: (attachments) => {
          payloads.push(...attachments);
          overrides.onAttachmentsChange?.(attachments);
        },
      }),
    ),
    container,
  );
  return container;
}

function getComposerTextarea(container: Element) {
  return expectDefined(
    container.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea"),
    "composer textarea",
  );
}

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
      "attachment file input",
    );
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [file], types: ["Files"] } });
    expectDefined(container.querySelector("section.chat"), "chat drop target").dispatchEvent(drop);
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
    requireElement(remounted, ".chat-attachment-file__open", "pasted text excerpt").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    requireElement(
      sidebar.container,
      ".chat-attachment-text-action",
      "show pasted text button",
    ).dispatchEvent(new MouseEvent("click", { bubbles: true }));

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
        attachmentReads: reads,
        readSignal,
        pendingAttachmentReads: reads.pendingReads,
        getPendingAttachmentReads: () => reads.pendingReads,
        onPendingReadsChange: (delta: 1 | -1) => reads.updatePending(readSignal, delta),
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
        const reader = expectDefined(readers[0], "pending attachment reader");
        Object.defineProperty(reader, "result", { value: "data:image/png;base64,YWJj" });
        reader.dispatchEvent(new ProgressEvent("load"));
        await Promise.resolve();
        const failed = renderChatView(props);
        expect(failed.querySelectorAll(".chat-attachment-thumb--error")).toHaveLength(1);
        expect(getComposerTextarea(failed).value).toBe(props.draft);
        expect(
          failed.querySelector(".chat-attachment-error")?.getAttribute("aria-label"),
        ).toContain("proof.png");
      }
      expect(reads.pendingReads).toBe(0);
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    },
  );

  it.each(["clipboard", "file picker", "drop"] as const)(
    "waits for an in-flight %s attachment before accepting an immediate send",
    async (entry) => {
      const readers = deferFileReaders();
      const container = document.createElement("div");
      const file = new File(["attachment proof"], "proof.png", { type: "image/png" });
      const draft = "Send the attachment with this message";
      let attachments: ChatAttachment[] = [];
      const onSend = vi.fn(() => {
        expect(attachments.map((attachment) => attachment.fileName)).toEqual(["proof.png"]);
      });
      const redraw = () => {
        const readSignal = reads.readSignal;
        render(
          renderChat(
            createChatProps({
              attachments,
              draft,
              getAttachments: () => attachments,
              getDraft: () => draft,
              getPendingAttachmentReads: () => reads.pendingReads,
              onAttachmentsChange: (next) => {
                attachments = next;
              },
              onPendingReadsChange: (delta) => reads.updatePending(readSignal, delta),
              onSend,
              attachmentReads: reads,
              pendingAttachmentReads: reads.pendingReads,
              readSignal,
            }),
          ),
          container,
        );
      };
      const reads = new ChatAttachmentReadLifecycle(redraw);
      onTestFinished(() => {
        reads.abortReads();
        releaseChatAttachmentPayloads(attachments);
        render(null, container);
      });
      redraw();

      attachFile(container, file, entry);

      expect(readers).toHaveLength(1);
      expect(reads.pendingReads).toBe(1);
      const status = container.querySelector(".chat-attachments-status");
      expect(status?.textContent).toContain("Preparing 1 attachment");
      expect(container.querySelectorAll('.chat-attachment-thumb[aria-busy="true"]')).toHaveLength(
        1,
      );
      const pendingTile = container.querySelector(".chat-attachment-thumb");
      expect(status?.querySelector(".btn__spinner")).toBeNull();
      expect(status?.getAttribute("role")).toBe("status");
      expect(status?.classList.contains("sr-only")).toBe(true);
      expect(getComposerTextarea(container).disabled).toBe(false);
      const send = expectDefined(
        container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "send button",
      );
      expect(send.disabled).toBe(true);
      expect(send.getAttribute("aria-busy")).toBe("true");
      expect(send.closest("openclaw-tooltip")?.content).toBe("Preparing attachments…");
      getComposerTextarea(container).dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
      );
      expect(onSend).not.toHaveBeenCalled();

      const reader = expectDefined(readers[0], "deferred attachment reader");
      Object.defineProperty(reader, "result", {
        configurable: true,
        value: `data:image/png;base64,${btoa("attachment proof")}`,
      });
      reader.dispatchEvent(new ProgressEvent("load"));

      await waitForFast(() => {
        expect(reads.pendingReads).toBe(0);
        expect(attachments.map((attachment) => attachment.fileName)).toEqual(["proof.png"]);
      });
      expect(container.querySelector(".chat-attachment-thumb")).toBe(pendingTile);
      expect(pendingTile?.getAttribute("aria-busy")).toBe("false");
      const readySend = expectDefined(
        container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "ready send button",
      );
      expect(readySend.disabled).toBe(false);
      expect(readySend.getAttribute("aria-busy")).toBe("false");
      expect(container.querySelector(".chat-attachments-status")?.textContent?.trim()).toBe("");
      readySend.click();
      expect(onSend).toHaveBeenCalledOnce();
    },
  );
});
