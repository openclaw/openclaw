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
])(
  "downloads $mimeType with its image extension and retains the payload for 30 seconds",
  async ({ mimeType, extension }) => {
    vi.useFakeTimers();
    const original = new Blob(["original image bytes"], { type: mimeType });
    const create = vi.fn(() => "blob:https://example.test/original");
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

    expect(create).toHaveBeenCalledExactlyOnceWith(original);
    expect(downloads).toEqual([
      { href: "blob:https://example.test/original", filename: `Original- image.${extension}` },
    ]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:https://example.test/original");
  },
);
