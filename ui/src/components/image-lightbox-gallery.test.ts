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
  it.each(["upgrade reset", "upgrade evict", "neighbor reset"] as const)(
    "releases a late image once without replacing newer intent: %s",
    async (action) => {
      const initial = imageItem("preview");
      const late = imageItem("original");
      const replacement = imageItem("replacement");
      const beyond = imageItem("beyond");
      const pending = createDeferred<ImageLightboxItem | null>();
      const load = vi.fn(() => pending.promise);
      const moving = action === "neighbor reset";
      const preview = moving ? initial : { ...initial, loadDisplayImage: load };
      controller.reset(
        {
          index: 0,
          items: [async () => preview, moving ? load : async () => replacement, async () => beyond],
        },
        preview,
      );
      const navigation = moving ? controller.move(1) : undefined;
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      if (moving) {
        expect(controller.current).toBe(initial);
        expect(controller.busy).toBe(true);
      }
      if (action === "upgrade evict") {
        expect(await controller.move(1)).toBe(true);
        expect(await controller.move(1)).toBe(true);
      } else {
        controller.reset(undefined, replacement);
      }
      pending.resolve(late);
      if (navigation) {
        expect(await navigation).toBe(false);
      }
      await vi.waitFor(() => expect(late.release).toHaveBeenCalledOnce());
      expect(controller.current).toBe(action === "upgrade evict" ? beyond : replacement);
      expect(controller.busy).toBe(false);
      expect(controller.failed).toBe(false);
      controller.dispose();
      await Promise.resolve();
      expect(late.release).toHaveBeenCalledOnce();
      expect(initial.release).not.toHaveBeenCalled();
      if (moving) {
        expect(replacement.release).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "upgrades a previous image without replacing a neighbor (return while loading=%s)",
    async (returnWhileLoading) => {
      const original = imageItem("original");
      const neighbor = imageItem("neighbor");
      const pending = createDeferred<ImageLightboxItem | null>();
      const load = vi.fn(() => pending.promise);
      const initial = { ...imageItem("preview"), loadDisplayImage: load };
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
    "keeps the preview and retries a failed display-image %s",
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
      const initial = { ...imageItem("preview"), loadDisplayImage: load };
      controller.reset(undefined, initial);
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
      if (failure === "decode") {
        await vi.waitFor(() => expect(original.release).toHaveBeenCalledOnce());
      }
      await vi.waitFor(() => expect(controller.upgradeFailed).toBe(true));
      expect(controller.current?.src).toBe(initial.src);
      expect(controller.failed).toBe(false);
      expect(controller.upgrading).toBe(false);
      expect(initial.release).not.toHaveBeenCalled();
      const recovered = imageItem("recovered-display");
      load.mockResolvedValueOnce(recovered);
      controller.retryDisplayImage();
      expect(controller.upgrading).toBe(true);
      await vi.waitFor(() => expect(controller.current).toBe(recovered));
      expect(controller.upgradeFailed).toBe(false);
      expect(load).toHaveBeenCalledTimes(2);
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
    expect(load).not.toHaveBeenCalled();
    expect(await controller.move(1)).toBe(false);
    expect(broken.release).toHaveBeenCalledOnce();
    expect(controller.current).toBe(initial);
    expect(controller.failed).toBe(true);

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

  it("loads only selected images, reuses visited neighbors, and releases evicted leases", async () => {
    const images = ["previous", "initial", "next", "beyond", "farthest"].map(imageItem);
    const loads = images.map((item) => vi.fn(async () => item));
    const initial = images[1]!;
    controller.reset({ index: 1, items: loads }, initial);
    await Promise.resolve();
    for (const load of loads) {
      expect(load).not.toHaveBeenCalled();
    }
    expect(decode).not.toHaveBeenCalled();

    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(images[2]);
    expect(loads[2]).toHaveBeenCalledExactlyOnceWith(true);
    expect(loads[0]).not.toHaveBeenCalled();
    expect(loads[3]).not.toHaveBeenCalled();
    expect(loads[4]).not.toHaveBeenCalled();
    expect(await controller.move(-1)).toBe(true);
    expect(controller.current?.src).toBe(initial.src);
    expect(await controller.move(1)).toBe(true);
    expect(loads[2]).toHaveBeenCalledOnce();
    expect(await controller.move(1)).toBe(true);
    expect(controller.current).toBe(images[3]);
    expect(loads[3]).toHaveBeenCalledExactlyOnceWith(true);
    expect(loads[4]).not.toHaveBeenCalled();
    expect(initial.release).not.toHaveBeenCalled();

    expect(await controller.move(-1)).toBe(true);
    expect(await controller.move(-1)).toBe(true);
    await Promise.resolve();
    expect(images[3]!.release).toHaveBeenCalledOnce();
    expect(loads[1]).toHaveBeenCalledOnce();
    controller.dispose();
    await Promise.resolve();
    expect(images[2]!.release).toHaveBeenCalledOnce();
    expect(initial.release).toHaveBeenCalledOnce();
    expect(images[0]!.release).not.toHaveBeenCalled();
    expect(images[4]!.release).not.toHaveBeenCalled();
  });
});
