import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveManagedImageThumbnail } from "./managed-image-thumbnail-cache.js";

it("joins queued thumbnails at capacity while refusing new work", async () => {
  const ready = createDeferredCore<Buffer>();
  const thumbnail = Buffer.from("thumbnail");
  const create = vi.fn(() => ready.promise);
  // Four active transforms and 128 queued transforms fill the admission budget.
  const admitted = Array.from({ length: 132 }, (_, index) =>
    resolveManagedImageThumbnail(`capacity-${index}`, create),
  );
  const excessCreate = vi.fn(async () => thumbnail);
  const excess = resolveManagedImageThumbnail("capacity-excess", excessCreate);
  const refused = expect(excess).rejects.toThrow("managed image thumbnail queue is full");
  const duplicateCreate = vi.fn(async () => Buffer.from("duplicate"));
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
