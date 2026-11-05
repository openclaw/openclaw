import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createImageLightboxGallery } from "./image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

function imageItem(title: string) {
  return { src: `https://example.com/${title}.png`, title, release: vi.fn() };
}

let decode: ReturnType<typeof vi.fn<() => Promise<void>>>;
let controller: ReturnType<typeof createImageLightboxGallery>;
let disposeGallery: () => void;
type Selection = ReturnType<typeof controller.peek>;
function expectSelection(current: ImageLightboxItem, fields: Partial<Omit<Selection, "current">>) {
  expect(controller.peek().current).toBe(current);
  expect(controller.peek()).toMatchObject(fields);
}
beforeEach(() => {
  decode = vi.fn(async () => {});
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
  controller = createRoot((dispose) => {
    disposeGallery = dispose;
    return createImageLightboxGallery();
  });
});

afterEach(() => {
  disposeGallery();
  vi.unstubAllGlobals();
});

it.each(["upgrade reset", "upgrade evict", "neighbor reset", "return pending", "return settled"])(
  "settles pending leases without replacing newer selection: %s",
  async (action) => {
    const initial = imageItem("preview"),
      late = imageItem("original");
    const replacement = imageItem("replacement"),
      beyond = imageItem("beyond");
    const pending = createDeferred<ImageLightboxItem | null>();
    const load = vi.fn(() => pending.promise);
    const moving = action === "neighbor reset",
      returning = action.startsWith("return");
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
      expectSelection(initial, { busy: true });
    }
    if (returning) {
      expect(await controller.move(1)).toBe(true);
      const back = action === "return pending" ? controller.move(-1) : undefined;
      pending.resolve(late);
      if (back) {
        expect(await back).toBe(true);
      } else {
        await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
        expectSelection(replacement, { index: 1 });
        expect(await controller.move(-1)).toBe(true);
      }
      expect(controller.peek().current).toBe(late);
      expect(load).toHaveBeenCalledOnce();
      return;
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
    expectSelection(action === "upgrade evict" ? beyond : replacement, {
      busy: false,
      failed: false,
    });
    disposeGallery();
    await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(initial.release).not.toHaveBeenCalled();
    if (moving) {
      expect(replacement.release).not.toHaveBeenCalled();
    }
  },
);

it("retries failed neighbor loads without losing selection", async () => {
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
  expectSelection(initial, { failed: true });

  expect(await controller.move(1)).toBe(false);
  expectSelection(initial, { index: 0, failed: true, busy: false });

  expect(await controller.move(1)).toBe(true);
  expectSelection(recovered, { index: 1, failed: false });
  disposeGallery();
  await vi.waitFor(() => expect(recovered.release).toHaveBeenCalledOnce());
  expect(broken.release).toHaveBeenCalledOnce();
  expect(initial.release).not.toHaveBeenCalled();
});

it("loads on selection, reuses neighbors and releases evictions", async () => {
  const images = ["previous", "initial", "next", "beyond", "farthest"].map(imageItem);
  const loads = images.map((item) => vi.fn(async () => item));
  const initial = images[1]!;
  controller.reset({ index: 1, items: loads }, initial);
  await Promise.resolve();
  expect(loads.map((load) => load.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
  expect(decode).not.toHaveBeenCalled();

  for (const index of [2, 1, 2, 3, 2, 1]) {
    expect(await controller.move(index - controller.peek().index)).toBe(true);
    if (index === 1) {
      expect(controller.peek().current?.src).toBe(initial.src);
    } else {
      expect(controller.peek().current).toBe(images[index]);
    }
    expect(initial.release).not.toHaveBeenCalled();
  }
  expect(loads.map((load) => load.mock.calls.length)).toEqual([0, 1, 1, 1, 0]);
  await Promise.resolve();
  expect(images[3]!.release).toHaveBeenCalledOnce();
  disposeGallery();
  await Promise.resolve();
  expect(images.map((image) => image.release.mock.calls.length)).toEqual([0, 1, 1, 1, 0]);
});
