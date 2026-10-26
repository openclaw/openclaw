import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { getChatAttachmentBlob, getChatAttachmentDataUrl } from "../attachment-payload-store.ts";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";

const browserMode = "__vitest_browser__" in globalThis;

describe.runIf(browserMode)("oversized composer images", () => {
  let source: File;
  beforeAll(async () => {
    const canvas = document.createElement("canvas");
    Object.assign(canvas, { width: 1600, height: 1000 });
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
    const png = expectDefined(blob, "fixture PNG");
    source = new File([png], "screenshot.png", { type: "image/png" });
    canvas.width = canvas.height = 0;
    expect(source.size).toBeGreaterThan(5 * 1024 * 1024);
  });

  it("resizes an oversized data-URL paste before publishing a bounded transparent PNG", async () => {
    const limit = 5 * 1024 * 1024;
    const { reads, props, attachments, pending, done, dispose } = createAttachmentDraft({
      maxBytes: 20 * 1024 * 1024,
      maxImageBytes: limit,
      maxBatchBytes: 20 * 1024 * 1024,
    });
    onTestFinished(dispose);
    const transfer = new DataTransfer();
    const sourceBytes = bytesToBase64(new Uint8Array(await source.arrayBuffer()));
    transfer.setData("text/plain", `data:image/png;base64,${sourceBytes}`);
    handleChatAttachmentPaste(new ClipboardEvent("paste", { clipboardData: transfer }), props);
    expect(reads.pendingReads).toBe(1);
    expect(attachments()).toEqual([]);
    await done;
    expect(pending).toEqual([1, 0]);
    expect(attachments()).toHaveLength(1);
    const attachment = expectDefined(attachments()[0], "prepared attachment");
    const blob = expectDefined(getChatAttachmentBlob(attachment), "prepared bytes");
    expect(blob.size).toBeLessThanOrEqual(limit);
    expect(blob.size).toBeGreaterThan(0);
    expect(attachment).toMatchObject({
      sizeBytes: blob.size,
      mimeType: "image/png",
      fileName: expect.stringMatching(/.png$/),
    });
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
  });
});
