import { afterEach, expect, it, vi } from "vitest";
import { downloadLightboxImage } from "../components/image-lightbox-files.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { mimeType: "image/jpeg", extension: "jpg" },
  { mimeType: "image/jpeg; charset=binary", extension: "jpg" },
  { mimeType: "IMAGE/JPEG ; CHARSET=UTF-8", extension: "jpg" },
  { mimeType: "image/png; charset=binary", extension: "png" },
  { mimeType: "image/heic", extension: "heic", attachmentOnly: true },
  { mimeType: "image/heif", extension: "heif", attachmentOnly: true },
])(
  "downloads $mimeType with its image extension and retains the payload for 30 seconds",
  async ({ mimeType, extension, attachmentOnly }) => {
    vi.useFakeTimers();
    const original = new Blob(["original image bytes"], { type: mimeType });
    const create = vi.fn((_blob: Blob) => "blob:https://example.test/original");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = revoke;
      },
    );
    const downloads: Array<{ href: string; filename: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, filename: this.download });
    });

    await downloadLightboxImage("blob:preview", "Original: image.png", async () => original);

    if (attachmentOnly) {
      expect(create).toHaveBeenCalledOnce();
      const content = create.mock.calls[0]?.[0];
      expect(content?.type).toBe("application/octet-stream");
      expect(await content?.arrayBuffer()).toEqual(await original.arrayBuffer());
    } else {
      expect(create).toHaveBeenCalledExactlyOnceWith(original);
    }
    expect(downloads).toEqual([
      { href: "blob:https://example.test/original", filename: `Original- image.${extension}` },
    ]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:https://example.test/original");
  },
);
