import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished } from "vitest";
import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";
import { resizeChatAttachmentImage } from "./chat-attachment-image.ts";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import { appendChatAttachmentFiles, handleChatAttachmentPaste } from "./chat-attachments.ts";

async function jpeg(width: number, height: number): Promise<File> {
  const canvas = document.createElement("canvas");
  Object.assign(canvas, { width, height });
  try {
    const context = expectDefined(canvas.getContext("2d"), "fixture context");
    context.fillStyle = "#2468ac";
    context.fillRect(0, 0, width, height);
    const blob = expectDefined(
      await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.9);
      }),
      "fixture JPEG",
    );
    return new File([blob], "synthetic.jpg", { type: "image/jpeg", lastModified: 1234 });
  } finally {
    canvas.width = canvas.height = 0;
  }
}

describe.runIf("__vitest_browser__" in globalThis)("dimension-aware attachment preparation", () => {
  it.each(["file", "data-url paste"] as const)(
    "prepares a below-byte-limit 37 MP JPEG via %s",
    async (route) => {
      const source = await jpeg(8160, 4590);
      const limit = 6 * 1024 * 1024;
      expect(source.size).toBeLessThan(limit);
      const draft = createAttachmentDraft({
        maxBytes: 20 * 1024 * 1024,
        maxImageBytes: limit,
        maxBatchBytes: 20 * 1024 * 1024,
      });
      onTestFinished(draft.dispose);
      if (route === "file") {
        appendChatAttachmentFiles([source], draft.props);
      } else {
        const transfer = new DataTransfer();
        transfer.setData(
          "text/plain",
          "data:image/jpeg;base64," + bytesToBase64(new Uint8Array(await source.arrayBuffer())),
        );
        handleChatAttachmentPaste(
          new ClipboardEvent("paste", { clipboardData: transfer }),
          draft.props,
        );
      }
      await draft.done;
      expect(draft.pending).toEqual([1, 0]);
      expect(draft.attachments()).toHaveLength(1);
      const attachment = expectDefined(draft.attachments()[0], "prepared attachment");
      const blob = expectDefined(getChatAttachmentBlob(attachment), "prepared bytes");
      expect(blob.size).toBeLessThanOrEqual(source.size);
      expect(attachment).toMatchObject({ mimeType: source.type });
      expect(attachment.fileName).toBe(route === "file" ? source.name : "pasted-image.jpeg");
      const bitmap = await createImageBitmap(blob);
      try {
        expect(bitmap.width).toBe(4096);
        expect(bitmap.height).toBe(2304);
      } finally {
        bitmap.close();
      }
    },
  );

  it("keeps acceptable JPEG bytes and metadata unchanged", async () => {
    const source = await jpeg(80, 60);
    const result = await resizeChatAttachmentImage(
      source,
      6 * 1024 * 1024,
      new AbortController().signal,
      () => {},
    );
    expect(result).toBe(source);
  });

  it("does not decode a JPEG above the bounded source budget", async () => {
    // SOI + valid-length baseline SOF header claiming 8000 x 5001 pixels (>40 MP).
    const source = new File(
      [new Uint8Array([255, 216, 255, 192, 0, 8, 8, 19, 137, 31, 64, 0])],
      "oversized.jpg",
      { type: "image/jpeg" },
    );
    await expect(
      resizeChatAttachmentImage(source, 6 * 1024 * 1024, new AbortController().signal, () => {}),
    ).rejects.toThrow("JPEG dimensions exceed the resize budget");
  });

  it("preserves cancellation before header inspection", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      resizeChatAttachmentImage(
        new File(["invalid"], "cancelled.jpg", { type: "image/jpeg" }),
        6 * 1024 * 1024,
        controller.signal,
        () => {},
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each(["portrait", "EXIF orientation 6"] as const)(
    "preserves %s while downscaling",
    async (kind) => {
      let source = await jpeg(kind === "portrait" ? 3000 : 5000, kind === "portrait" ? 5000 : 3000);
      if (kind !== "portrait") {
        // APP1 Exif, little-endian TIFF, one SHORT orientation entry (rotate 90 CW).
        const exif = new Uint8Array([
          255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1,
          0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ]);
        const bytes = new Uint8Array(await source.arrayBuffer());
        source = new File([bytes.slice(0, 2), exif, bytes.slice(2)], source.name, {
          type: source.type,
          lastModified: source.lastModified,
        });
      }
      const original = await source.arrayBuffer();
      const prepared = await resizeChatAttachmentImage(
        source,
        6 * 1024 * 1024,
        new AbortController().signal,
        () => {},
      );
      expect(prepared.type).toBe(source.type);
      expect(prepared.name).toBe(source.name);
      expect(prepared.lastModified).toBe(source.lastModified);
      expect(await source.arrayBuffer()).toEqual(original);
      const bitmap = await createImageBitmap(prepared);
      try {
        expect(bitmap.height).toBe(4096);
        expect(bitmap.width).toBeLessThan(bitmap.height);
        expect(bitmap.width / bitmap.height).toBeCloseTo(0.6, 2);
      } finally {
        bitmap.close();
      }
    },
  );

  it.each([
    [255, 216, 255, 224, 0, 1],
    [255, 216, 255, 224, 255, 255],
    [255, 216, 255, 195, 0, 8, 8, 0, 1, 0, 1, 0],
    [255, 216, ...Array.from({ length: 1024 }, () => 255)],
  ])("rejects malformed, unsupported or excessive JPEG marker headers", async (...bytes) => {
    await expect(
      resizeChatAttachmentImage(
        new File([new Uint8Array(bytes)], "invalid.jpg", { type: "image/jpeg" }),
        6 * 1024 * 1024,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("handles standalone JPEG markers without reading them as segment lengths", async () => {
    const source = await jpeg(80, 60);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const marked = new File(
      [bytes.slice(0, 2), new Uint8Array([255, 1, 255, 208]), bytes.slice(2)],
      source.name,
      { type: source.type },
    );
    expect(
      await resizeChatAttachmentImage(
        marked,
        6 * 1024 * 1024,
        new AbortController().signal,
        () => {},
      ),
    ).toBe(marked);
  });

  it("does not flatten an APNG that needs dimension preparation", async () => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=",
      ),
      (char) => char.charCodeAt(0),
    );
    new DataView(bytes.buffer).setUint32(16, 5000);
    const control = new Uint8Array(20);
    new DataView(control.buffer).setUint32(0, 8);
    new DataView(control.buffer).setUint32(4, 0x6163544c);
    const source = new File([bytes.slice(0, 33), control, bytes.slice(33)], "animated.png", {
      type: "image/png",
    });
    await expect(
      resizeChatAttachmentImage(source, 6 * 1024 * 1024, new AbortController().signal, () => {}),
    ).rejects.toThrow("Animated PNG");
  });

  it("reports a corrupt JPEG worker decode without publishing a replacement", async () => {
    const source = new File(
      [new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 1, 19, 136, 0])],
      "corrupt.jpg",
      { type: "image/jpeg" },
    );
    await expect(
      resizeChatAttachmentImage(source, 6 * 1024 * 1024, new AbortController().signal, () => {}),
    ).rejects.toThrow("Image preparation failed");
  });
});
