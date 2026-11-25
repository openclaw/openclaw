import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  encodeImageThumbnail,
  resolveManagedImageThumbnail,
  type ManagedImageThumbnail,
} from "./managed-image-thumbnail-cache.js";

it("joins queued thumbnails at capacity while refusing new work", async () => {
  const ready = createDeferredCore<ManagedImageThumbnail>();
  const thumbnail: ManagedImageThumbnail = {
    data: Buffer.from("thumbnail"),
    extension: ".webp",
    mimeType: "image/webp",
  };
  const create = vi.fn(() => ready.promise);
  // Four active transforms and 128 queued transforms fill the admission budget.
  const admitted = Array.from({ length: 132 }, (_, index) =>
    resolveManagedImageThumbnail(`capacity-${index}`, create),
  );
  const excessCreate = vi.fn(async () => thumbnail);
  const excess = resolveManagedImageThumbnail("capacity-excess", excessCreate);
  const refused = expect(excess).rejects.toThrow("managed image thumbnail queue is full");
  const duplicateCreate = vi.fn(async () => ({ ...thumbnail, data: Buffer.from("duplicate") }));
  const joined = resolveManagedImageThumbnail("capacity-131", duplicateCreate);
  try {
    ready.resolve(thumbnail);
    await refused;
    await Promise.all(admitted);
    await expect(joined).resolves.toBe(thumbnail);
    expect(create).toHaveBeenCalledTimes(132);
    expect(duplicateCreate).not.toHaveBeenCalled();
    expect(excessCreate).not.toHaveBeenCalled();
    await expect(resolveManagedImageThumbnail("capacity-excess", excessCreate)).resolves.toBe(
      thumbnail,
    );
    expect(excessCreate).toHaveBeenCalledOnce();
  } finally {
    ready.resolve(thumbnail);
    await Promise.allSettled([...admitted, excess, joined]);
  }
});

it.each(["hevc", "msf1"])("refuses HEIF sequence brand %s before transcoding", async (brand) => {
  const source = await readFile(new URL("./fixtures/thumbnail-still.heic", import.meta.url));
  // Change the file type brand without needing a platform codec for sequences.
  source.write(brand, 8, "ascii");
  await expect(encodeImageThumbnail(source)).rejects.toThrow(
    "Managed image thumbnail is unavailable for this image format",
  );
});
