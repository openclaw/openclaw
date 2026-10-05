/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTabIconPreference } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import { fileToTabIconImage } from "./tab-icon-image.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=";
const WEBP =
  "data:image/webp;base64," + btoa("RIFF" + "\0".repeat(4) + "WEBPVP8 " + "\0".repeat(4));
const file = (type = "image/png", name = "icon.png", bytes = 3) =>
  new File([new Uint8Array(bytes)], name, { type });
const config = () => {
  const baseConfig = createApplicationConfigCapability({ resourceBasePath: "" });
  return { ...baseConfig, current: { ...baseConfig.current } };
};
const signal = () => new AbortController().signal;

function stubCanvas(encode: (mime: string | undefined, edge: number) => string = () => PNG) {
  const bitmap = { width: 128, height: 64, close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const context = { clearRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const encoder = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
    this: HTMLCanvasElement,
    mime?: string,
  ) {
    return encode(mime, this.width);
  });
  return { bitmap, context, encoder };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("tab icon image processing", () => {
  it.each(["image/png", "image/jpeg", "image/webp"])(
    "fits %s into a square without cropping",
    async (mime) => {
      const { bitmap, context, encoder } = stubCanvas(() => WEBP);
      const result = await fileToTabIconImage(file(mime), config(), signal());
      expect(result).toEqual({ ok: true, image: { dataUrl: WEBP, fileName: "icon.png" } });
      expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 8, 32, 16);
      expect(encoder).toHaveBeenCalledWith("image/webp", 0.8);
      expect(bitmap.close).toHaveBeenCalledOnce();
    },
  );

  it("falls back to 16px PNG using the complete UTF-8 preference budget", async () => {
    // The image alone fits, but the 128-character Unicode filename pushes
    // the serialized value over 4096 UTF-8 bytes.
    const oversized =
      "data:image/webp;base64," + btoa("RIFF" + "\0".repeat(4) + "WEBPVP8 " + "\0".repeat(2_800));
    expect(oversized.length).toBeLessThan(4_096);
    const { context, encoder } = stubCanvas((mime, edge) =>
      edge === 16 && mime === "image/png" ? PNG : oversized,
    );
    const result = await fileToTabIconImage(
      file("image/jpeg", "界".repeat(180)),
      config(),
      signal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected processed image");
    }
    expect(result.image.fileName).toHaveLength(128);
    expect(normalizeTabIconPreference({ mode: "custom", image: result.image })).toBeDefined();
    expect(context.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 4, 16, 8);
    expect(encoder.mock.calls.map(([mime]) => mime)).toEqual([
      "image/webp",
      "image/png",
      "image/webp",
      "image/png",
    ]);
  });

  it("rejects oversized output rather than persisting the original file", async () => {
    stubCanvas(() => PNG + "A".repeat(4_096));
    await expect(fileToTabIconImage(file(), config(), signal())).resolves.toEqual({
      ok: false,
      reason: "too-detailed",
    });
  });

  it.each(["image/svg+xml", "image/gif", "text/plain"])(
    "rejects %s before decoding",
    async (mime) => {
      const { bitmap } = stubCanvas();
      await expect(fileToTabIconImage(file(mime), config(), signal())).resolves.toEqual({
        ok: false,
        reason: "unusable",
      });
      expect(createImageBitmap).not.toHaveBeenCalled();
      expect(bitmap.close).not.toHaveBeenCalled();
    },
  );

  it("rejects files above the existing 2 MiB source policy", async () => {
    stubCanvas();
    await expect(
      fileToTabIconImage(file("image/png", "large.png", 2 * 1024 * 1024 + 1), config(), signal()),
    ).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("never falls back to raw bytes after decode or canvas failure", async () => {
    const { bitmap } = stubCanvas();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await expect(fileToTabIconImage(file(), config(), signal())).resolves.toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(bitmap.close).toHaveBeenCalledOnce();
    vi.mocked(createImageBitmap).mockRejectedValue(new Error("decode failed"));
    await expect(fileToTabIconImage(file(), config(), signal())).resolves.toEqual({
      ok: false,
      reason: "unusable",
    });
  });

  it("rechecks cancellation and upload policy after decoding", async () => {
    const { bitmap, encoder } = stubCanvas();
    const owner = config();
    const controller = new AbortController();
    const cancelled = fileToTabIconImage(file(), owner, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toEqual({ ok: false, reason: "cancelled" });
    const disabled = fileToTabIconImage(file(), owner, signal());
    owner.current.uploadsEnabled = false;
    await expect(disabled).resolves.toEqual({ ok: false, reason: "unusable" });
    expect(encoder).not.toHaveBeenCalled();
    expect(bitmap.close).toHaveBeenCalledTimes(2);
    await expect(fileToTabIconImage(file(), owner, signal())).rejects.toThrow();
  });
});
