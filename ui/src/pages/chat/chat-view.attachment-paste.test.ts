import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ComposerEditor } from "../../components/composer-editor.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, createPasteEvent } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";

const payloads: ChatAttachment[] = [];

afterEach(() => {
  releaseChatAttachmentPayloads(payloads.splice(0));
  resetChatViewState();
  resetTranscriptTestDom();
  vi.restoreAllMocks();
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
    container.querySelector<ComposerEditor>(
      ".agent-chat__composer-combobox > openclaw-composer-editor",
    ),
    "composer textarea",
  );
}

describe("chat attachment paste", () => {
  it("converts supported-size pasted image bytes into an attachment", () => {
    const onAttachmentsChange = vi.fn<(attachments: ChatAttachment[]) => void>();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = getComposerTextarea(container);
    const base64 = Buffer.alloc(4 * 1024 * 1024, 0xab).toString("base64");
    const allowed = textarea.dispatchEvent(createPasteEvent(`data:image/png;base64,${base64}`, []));
    expect(allowed).toBe(false);
    const attachments = expectDefined(onAttachmentsChange.mock.calls[0]?.[0], "pasted attachments");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.sizeBytes).toBe(4 * 1024 * 1024);
    expect(getChatAttachmentDataUrl(expectDefined(attachments[0], "pasted image"))).toBe(
      `data:image/png;base64,${base64}`,
    );
  });

  it.each(["AA$A", "QQ=Q", "===="])(
    "leaves invalid pasted image bytes %s out of attachments",
    (data) => {
      const onAttachmentsChange = vi.fn<(attachments: ChatAttachment[]) => void>();
      const container = renderChatView({ onAttachmentsChange });
      getComposerTextarea(container).dispatchEvent(
        createPasteEvent(`data:image/png;base64,${data}`, []),
      );
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    },
  );
});

describe("chat attachment reading", () => {
  it.each(["clipboard", "file picker", "drop"] as const)(
    "waits for an in-flight %s attachment before accepting an immediate send",
    async (entry) => {
      const readers: FileReader[] = [];
      vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(
        function (this: FileReader) {
          readers.push(this);
        },
      );
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

      if (entry === "clipboard") {
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", {
          value: {
            items: [{ type: file.type, getAsFile: () => file }],
            getData: () => "",
          },
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
        Object.defineProperty(drop, "dataTransfer", {
          value: { files: [file], types: ["Files"] },
        });
        expectDefined(container.querySelector("section.chat"), "chat drop target").dispatchEvent(
          drop,
        );
      }

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

  it("does not attach an aborted file read to a newly selected session", async () => {
    const readers: FileReader[] = [];
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      readers.push(this);
    });
    const reads = new ChatAttachmentReadLifecycle(() => undefined);
    const oldSignal = reads.readSignal;
    const onAttachmentsChange = vi.fn();
    const file = new File(["private session A"], "private.png", { type: "image/png" });
    const container = renderChatView({
      getPendingAttachmentReads: () => reads.pendingReads,
      onAttachmentsChange,
      onPendingReadsChange: (delta) => reads.updatePending(oldSignal, delta),
      attachmentReads: reads,
      pendingAttachmentReads: reads.pendingReads,
      readSignal: oldSignal,
      sessionKey: "agent:main:session-a",
    });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [file], types: ["Files"] },
    });
    expectDefined(container.querySelector("section.chat"), "session A drop target").dispatchEvent(
      drop,
    );

    expect(readers).toHaveLength(1);
    expect(reads.pendingReads).toBe(1);
    reads.abortReads();
    await Promise.resolve();
    await Promise.resolve();

    expect(oldSignal.aborted).toBe(true);
    expect(reads.pendingReads).toBe(0);
    expect(reads.readSignal).not.toBe(oldSignal);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
});
