import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished } from "vitest";
import { bytesToBase64 } from "../../../lib/bytes-base64.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";
import { resizeChatAttachmentImage } from "./chat-attachment-image.ts";
import { createAttachmentDraft } from "./chat-attachment-preparation.test-support.ts";
import { appendChatAttachmentFiles, handleChatAttachmentPaste } from "./chat-attachments.ts";

async function jpeg(width: number, height: number, mimeType = "image/jpeg"): Promise<File> {
  const canvas = document.createElement("canvas");
  Object.assign(canvas, { width, height });
  try {
    const context = expectDefined(canvas.getContext("2d"), "fixture context");
    context.fillStyle = "#2468ac";
    context.fillRect(0, 0, width, height);
    const blob = expectDefined(
      await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, mimeType, 0.9);
      }),
      "fixture JPEG",
    );
    return new File([blob], "synthetic-image", { type: mimeType, lastModified: 1234 });
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
      resizeChatAttachmentImage(source, source.size - 1, new AbortController().signal, () => {}),
    ).rejects.toThrow("JPEG dimensions exceed the resize budget");
  });

  it.each([
    [8000, 6000, "image/jpeg"],
    [5120, 10472, "image/png"],
  ] as const)(
    "preserves byte-valid %sx%s %s beyond the browser decode cap",
    async (width, height, type) => {
      const source = await jpeg(width, height, type);
      expect(source.size).toBeLessThan(6 * 1024 * 1024);
      expect(
        await resizeChatAttachmentImage(
          source,
          6 * 1024 * 1024,
          new AbortController().signal,
          () => {},
        ),
      ).toBe(source);
    },
  );

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

  it.each(["file", "data-url paste"] as const)(
    "preserves byte-valid 5000x1000 APNG animation via %s and rejects byte overflow",
    async (route) => {
      // Valid two-frame, 1-bit grayscale APNG: black then white, 100 ms per frame.
      // 5000x1000 (5 MP) exceeds the side target, not the 25 MP decode budget.
      const bytes = Uint8Array.from(atob(
        "iVBORw0KGgoAAAANSUhEUgAAE4gAAAPoAQAAAAAaySnyAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAABOIAAAD6AAAAAAAAAAAAAEACgAAAkGFdwAAAnVJREFUeNrtwTEBAAAAwqD1T20KP6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgZ43XAAHnmKFsAAAAGmZjVEwAAAABAAATiAAAA+gAAAAAAAAAAAABAAoAAJkyb6MAAAbpZmRBVAAAAAJ42u3SQREAAAzCMPybBhf7LJHQawqXIgGOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4cByOw3HgOBwHjsNx4Dgch+PAcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4DgcB47DcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4DgcB47DcTgOHIfjwHE4DhyH43AcOA7HgeNwHDgOx+E4cByOA8fhOHAcjsNx4DgcB47DceA4HIfjwHE4DhyH48BxOA7HgeNwHDgOx+E4CXAcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DseB43AcjgPH4ThwHI4Dx+E4HAeOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4cByOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4cByOw3HgOBwHjsNx4Dgch+PAcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4DgcB47DcTgOHIfjwHE4DsdJgONwHDgOx4HjcByOA8fhOHAcjgPH4TgcB47DceA4HAeOw3E4DhyH48BxOA4ch+NwHDgOx4HjcBw4DsfhOHAcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DseB43AcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DseB43AcjgPH4ThwHI4Dx+E4HAeOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4cByOw3HgOBwHjsNxOE4CHIfjwHE4DhyH43AcOA7HgeNwHDgOx+E4cByOA8fhOHAcjsNx4DgcB47DceA4HIfjwHE4DhyH48BxOA7HgeNwHDgOx4HjcByOA8fhOHAcjgPH4TgcB47DceA4HAeOw3E4DhyH48BxOA4ch+NwHDgOx4HjcByOA8fhOHAcjgPH4TgcB47DceA4HAeOw3E4DhyH48BxOA4ch+NwHDgOx4HjcBw4DsfhOHAcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DseB43AcjgPH4ThwHI7DcRLgOBwHjsNx4Dgch+PAcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4DgcB47DcTgOHIfjwHE4DhyH43AcOA7HgeNwHDgOx+E4cByOA8fhOHAcjsNx4DgcB47DceA4HIfjwHE4DhyH43AcOA7HgeNwHDgOx+E4cByOA8fhOHAcjsNx4DgcB47DceA4HIfjwHE4DhyH48BxOA7HgeNwHDgOx4HjcByOA8fhOHAcjgPH4TgcB47DceA4HAeOw3E4DhyH48BxOA4ch+NwHDgOx4HjcByOkwDH4ThwHI4Dx+E4HAeOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4cByOw3HgOBwHjsNx4Dgch+PAcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4Dgch+PAcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4DgcB47DcTgOHIfjwHE4DhyH43AcOA7HgeNwHDgOx+E4cByOA8fhOHAcjsNx4DgcB47DceA4HIfjwHE4DhyH43CcBDgOx4HjcBw4DsfhOHAcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DseB43AcjgPH4ThwHI4Dx+E4HAeOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4HAeOw3HgOBwHjsNxOA4ch+PAcTgOHIfjcBw4DseB43AcOA7H4ThwHI4Dx+E4cByOw3HgOBwHjsNx4Dgch+PAcTgOHIfjwHE4DseB43AcOA7HgeNwHI4Dx+E4cByOA8fhOBwHjsNx4Dgch+MkwHE4DhyH48BxOA7HgeNwHDgOx4HjcByOA8fhOHAcjgPH4TgcB47DceA4HAeOw3E4DhyH48BxOA4ch+NwHDgOx4HjcBw4DsfhOHAcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DsfhOHAcjgPH4ThwHI7DceA4HAeOw3HgOByH48BxOA4ch+PAcTgOx4HjcBw4DseB43Aczww+4G0Zl51kjAAAAABJRU5ErkJggg=="
      ), (char) => char.charCodeAt(0));
      const source = new File([bytes], "animated.png", { type: "image/png" });
      const bitmap = await createImageBitmap(source);
      try {
        expect([bitmap.width, bitmap.height]).toEqual([5000, 1000]);
      } finally {
        bitmap.close();
      }
      const processing: boolean[] = [];
      expect(await resizeChatAttachmentImage(
        source, source.size, new AbortController().signal, (value) => processing.push(value),
      )).toBe(source);
      expect(processing).toEqual([]);
      await expect(resizeChatAttachmentImage(
        source, source.size - 1, new AbortController().signal, (value) => processing.push(value),
      )).rejects.toThrow("Animated PNG");
      expect(processing).toEqual([]);
      for (const limit of [source.size, source.size - 1]) {
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
          transfer.setData("text/plain", "data:image/png;base64," + bytesToBase64(bytes));
          handleChatAttachmentPaste(new ClipboardEvent("paste", { clipboardData: transfer }), draft.props);
        }
        await draft.done;
        expect(draft.pending).toEqual([1, 0]);
        expect(draft.reads.failureCount).toBe(limit === source.size ? 0 : 1);
        expect(draft.attachments()).toHaveLength(limit === source.size ? 1 : 0);
        if (limit === source.size) {
          const attachment = expectDefined(draft.attachments()[0], "animated attachment");
          const payload = expectDefined(getChatAttachmentBlob(attachment), "original APNG");
          expect(attachment.mimeType).toBe("image/png");
          expect(new Uint8Array(await payload.arrayBuffer())).toEqual(bytes);
        }
      }
    },
  );

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
