import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  getChatAttachmentBlob,
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { renderChatAttachmentInputs } from "./chat-attachment-inputs.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";
import { createChatAttachmentDropHandlers, handleChatAttachmentPaste } from "./chat-attachments.ts";

const browserMode = "__vitest_browser__" in globalThis;

describe.runIf(browserMode)("oversized composer images", () => {
  let source: File;
  beforeAll(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1000;
    const context = expectDefined(canvas.getContext("2d"), "fixture canvas");
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 17;
    for (let i = 0; i < pixels.data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[i] = seed & 255;
    }
    // Keep one transparent region to catch accidental conversion to opaque JPEG.
    pixels.data.fill(0, 0, canvas.width * 4 * 20);
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    source = new File([expectDefined(blob, "fixture PNG")], "screenshot.png", {
      type: "image/png",
    });
    canvas.width = canvas.height = 0;
    expect(source.size).toBeGreaterThan(5 * 1024 * 1024);
  });

  it.each(["drop", "picker", "data-url paste"] as const)(
    "prepares a large PNG from %s before publishing a bounded payload",
    async (route) => {
      const done = createDeferred();
      const reads = new ChatAttachmentReadLifecycle(() => {});
      const signal = reads.readSignal;
      let attachments: ChatAttachment[] = [];
      const pending: number[] = [];
      const limit = 5 * 1024 * 1024;
      const props: ChatAttachmentControlsProps = {
        attachments,
        getAttachments: () => attachments,
        attachmentLimits: {
          maxBytes: 20 * 1024 * 1024,
          maxImageBytes: limit,
          maxBatchBytes: 20 * 1024 * 1024,
        },
        attachmentReads: reads,
        readSignal: signal,
        onAttachmentsChange: (next) => {
          attachments = next;
        },
        onPendingReadsChange: (delta) => {
          reads.updatePending(signal, delta);
          pending.push(reads.pendingReads);
          if (reads.pendingReads === 0) {
            done.resolve();
          }
        },
      };
      const host = document.createElement("div");
      document.body.append(host);
      onTestFinished(() => {
        reads.abortReads();
        releaseChatAttachmentPayloads(attachments);
        render(null, host);
        host.remove();
      });
      const transfer = new DataTransfer();
      transfer.items.add(source);
      if (route === "drop") {
        const handlers = createChatAttachmentDropHandlers({ ...props, canCompose: true });
        host.addEventListener("drop", handlers.onDrop);
        host.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
      } else if (route === "picker") {
        render(renderChatAttachmentInputs(props), host);
        const input = expectDefined(host.querySelector<HTMLInputElement>("input"), "file picker");
        input.files = transfer.files;
        input.dispatchEvent(new Event("change"));
      } else {
        const reader = new FileReader();
        const loaded = new Promise<void>((resolve) => {
          reader.addEventListener("load", () => resolve(), { once: true });
        });
        reader.readAsDataURL(source);
        await loaded;
        transfer.items.clear();
        if (typeof reader.result !== "string") {
          throw new Error("Image fixture did not encode");
        }
        transfer.setData("text/plain", reader.result);
        handleChatAttachmentPaste(new ClipboardEvent("paste", { clipboardData: transfer }), props);
      }
      expect(reads.pendingReads).toBe(1);
      expect(attachments).toEqual([]);
      await done.promise;
      expect(pending).toEqual([1, 0]);
      expect(attachments).toHaveLength(1);
      const attachment = expectDefined(attachments[0], "prepared attachment");
      const blob = expectDefined(getChatAttachmentBlob(attachment), "prepared bytes");
      expect(blob.size).toBeLessThanOrEqual(limit);
      expect(blob.size).toBeGreaterThan(0);
      expect(attachment.sizeBytes).toBe(blob.size);
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.fileName).toMatch(/.png$/);
      const encoded = expectDefined(getChatAttachmentDataUrl(attachment), "send payload");
      expect(encoded.startsWith("data:image/png;base64,")).toBe(true);
      expect(atob(encoded.split(",")[1] ?? "").length).toBe(blob.size);
      const image = await createImageBitmap(blob);
      try {
        expect(image.width).toBeLessThan(1600);
        expect(image.height).toBeLessThan(1000);
        expect(image.width / image.height).toBeCloseTo(1.6, 2);
        const canvas = document.createElement("canvas");
        const context = expectDefined(canvas.getContext("2d"), "output canvas");
        context.drawImage(image, 0, 0);
        expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(0);
      } finally {
        image.close();
      }
    },
  );
});
