import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ImageLightboxGalleryController } from "./image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

function imageItem(title: string) {
  return { src: `https://example.com/${title}.png`, title, release: vi.fn() };
}

let decode: ReturnType<typeof vi.fn<() => Promise<void>>>;
let controller: ImageLightboxGalleryController;

beforeEach(() => {
  decode = vi.fn(async () => {});
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
  controller = new ImageLightboxGalleryController(vi.fn());
});

afterEach(() => {
  controller.dispose();
  vi.unstubAllGlobals();
});

describe("image lightbox gallery resource lifecycle", () => {
  it.each(["close", "reset", "evict"] as const)(
    "releases a late full-resolution image after %s without replacing newer intent",
    async (action) => {
      const initial = imageItem("preview");
      const original = imageItem("original");
      const replacement = imageItem("replacement");
      const beyond = imageItem("beyond");
      const pending = createDeferred<ImageLightboxItem | null>();
      const load = vi.fn(() => pending.promise);
      const preview = { ...initial, loadFullResolution: load };
      controller.reset(
        {
          index: 0,
          items: [async () => preview, async () => replacement, async () => beyond],
        },
        preview,
      );
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

      if (action === "reset") {
        controller.reset(undefined, replacement);
      } else if (action === "evict") {
        expect(await controller.move(1)).toBe(true);
        expect(await controller.move(1)).toBe(true);
      } else {
        controller.dispose();
      }
      pending.resolve(original);
      await vi.waitFor(() => expect(original.release).toHaveBeenCalledOnce());
      expect(controller.current).toBe(
        action === "close" ? undefined : action === "evict" ? beyond : replacement,
      );
      controller.dispose();
      await Promise.resolve();
      expect(original.release).toHaveBeenCalledOnce();
      expect(initial.release).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "upgrades a previous image without replacing a neighbor (return while loading=%s)",
    async (returnWhileLoading) => {
      const original = imageItem("original");
      const neighbor = imageItem("neighbor");
      const pending = createDeferred<ImageLightboxItem | null>();
      const load = vi.fn(() => pending.promise);
      const initial = { ...imageItem("preview"), loadFullResolution: load };
      controller.reset({ index: 0, items: [async () => initial, async () => neighbor] }, initial);
      expect(await controller.move(1)).toBe(true);
      const returning = returnWhileLoading ? controller.move(-1) : undefined;
      pending.resolve(original);
      if (returning) {
        expect(await returning).toBe(true);
      } else {
        await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
        expect(controller.current).toBe(neighbor);
        expect(controller.index).toBe(1);
        expect(await controller.move(-1)).toBe(true);
      }
      expect(controller.current).toBe(original);
      expect(load).toHaveBeenCalledOnce();
    },
  );

  it.each(["fetch", "decode"] as const)(
    "keeps the preview when the full image fails to %s",
    async (failure) => {
      const original = imageItem("original");
      if (failure === "decode") {
        decode.mockRejectedValueOnce(new Error("Image decode failed"));
      }
      const load = vi.fn(async () => {
        if (failure === "fetch") {
          throw new Error("Image unavailable");
        }
        return original;
      });
      const initial = { ...imageItem("preview"), loadFullResolution: load };
      controller.reset(undefined, initial);
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      if (failure === "decode") {
        await vi.waitFor(() => expect(original.release).toHaveBeenCalledOnce());
      }
      expect(controller.current).toBe(initial);
      expect(controller.failed).toBe(false);
      expect(initial.release).not.toHaveBeenCalled();
    },
  );

  it.each(["close", "reset"] as const)(
    "releases a late image once after %s without replacing the current selection",
    async (action) => {
      const initial = imageItem("initial");
      const late = imageItem("late");
      const replacement = imageItem("replacement");
      const pending = createDeferred<ImageLightboxItem | null>();
      const load = vi.fn(() => pending.promise);
      controller.reset({ index: 0, items: [async () => initial, load] }, initial);
      const moving = controller.move(1);
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      expect(controller.current).toBe(initial);
      expect(controller.busy).toBe(true);

      if (action === "reset") {
        controller.reset(undefined, replacement);
      } else {
        controller.dispose();
      }
      pending.resolve(late);

      expect(await moving).toBe(false);
      await vi.waitFor(() => expect(late.release).toHaveBeenCalledOnce());
      expect(controller.current).toBe(action === "reset" ? replacement : undefined);
      expect(controller.busy).toBe(false);
      expect(controller.failed).toBe(false);
      controller.dispose();
      await Promise.resolve();
      expect(late.release).toHaveBeenCalledOnce();
      expect(initial.release).not.toHaveBeenCalled();
      expect(replacement.release).not.toHaveBeenCalled();
    },
  );

  it("keeps the current image after a failed neighbor load and retries on navigation", async () => {
    const initial = imageItem("initial");
    const broken = imageItem("broken");
    const recovered = imageItem("recovered");
    const load = vi
      .fn<() => Promise<ImageLightboxItem | null>>()
      .mockResolvedValueOnce(broken)
      .mockRejectedValueOnce(new Error("Image temporarily unavailable"))
      .mockResolvedValue(recovered);
    decode.mockRejectedValueOnce(new Error("Image decode failed"));
    controller.reset({ index: 0, items: [async () => initial, load] }, initial);
    await vi.waitFor(() => expect(broken.release).toHaveBeenCalledOnce());
    // A failed speculative preload does not replace the visible image with an error.
    expect(controller.current).toBe(initial);
    expect(controller.failed).toBe(false);

    expect(await controller.move(1)).toBe(false);
    expect(controller.current).toBe(initial);
    expect(controller.index).toBe(0);
    expect(controller.failed).toBe(true);
    expect(controller.busy).toBe(false);

    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(recovered);
    expect(controller.index).toBe(1);
    expect(controller.failed).toBe(false);
    controller.dispose();
    await vi.waitFor(() => expect(recovered.release).toHaveBeenCalledOnce());
    expect(broken.release).toHaveBeenCalledOnce();
    expect(initial.release).not.toHaveBeenCalled();
  });

  it("preloads only adjacent images and releases evicted leases before closing", async () => {
    const previous = imageItem("previous");
    const initial = imageItem("initial");
    const next = imageItem("next");
    const beyond = imageItem("beyond");
    const farthest = imageItem("farthest");
    const images = [previous, initial, next, beyond, farthest];
    const loads = images.map((item) => vi.fn(async () => item));
    controller.reset({ index: 1, items: loads }, initial);
    await vi.waitFor(() => {
      expect(loads[0]).toHaveBeenCalledOnce();
      expect(loads[2]).toHaveBeenCalledOnce();
    });
    expect(loads[1]).not.toHaveBeenCalled();
    expect(loads[3]).not.toHaveBeenCalled();
    expect(loads[4]).not.toHaveBeenCalled();

    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(images[2]);
    await vi.waitFor(() => expect(previous.release).toHaveBeenCalledOnce());
    expect(next.release).not.toHaveBeenCalled();
    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(images[3]);
    await vi.waitFor(() => expect(loads[4]).toHaveBeenCalledOnce());
    expect(initial.release).not.toHaveBeenCalled();

    controller.dispose();
    await vi.waitFor(() => {
      for (const image of [previous, next, beyond, farthest]) {
        expect(image.release).toHaveBeenCalledOnce();
      }
    });
    expect(initial.release).not.toHaveBeenCalled();
  });
});
