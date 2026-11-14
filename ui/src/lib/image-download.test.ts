import { afterEach, expect, it, vi } from "vitest";
import { downloadLightboxImage } from "../components/image-lightbox-files.ts";
import { downloadImageBlob } from "./image-download.ts";

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

it.each(["image/svg+xml", "image/svg+xml; charset=utf-8"])(
  "downloads inline %s originals as inert SVG files",
  async (type) => {
    vi.useFakeTimers();
    const bytes = '<svg xmlns="http://www.w3.org/2000/svg"><text>Original</text></svg>\r\n';
    const original = new Blob([bytes], { type });
    const create = vi.fn((_blob: Blob) => "blob:https://example.test/svg");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = revoke;
      },
    );
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filenames.push(this.download);
    });

    downloadImageBlob(original, "parcel flow.svg");

    expect(filenames).toEqual(["parcel flow.svg"]);
    const payload = create.mock.calls[0]?.[0] as Blob;
    expect(payload.type).toBe("application/octet-stream");
    expect(await payload.text()).toBe(bytes);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:https://example.test/svg");
  },
);
