import type { Worker } from "node:worker_threads";
import { encodePngRgba } from "rastermill";
import { afterAll, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => [] as Worker[]);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
      }
    },
  };
});

import { createImageProcessor, getImageMetadata, resizeToJpeg } from "./image-ops.js";

afterAll(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
  "base64",
);

describe("image worker", () => {
  it("returns encoded Buffer bytes without detaching the caller's input view", async () => {
    const source = Buffer.concat([Buffer.from("prefix"), png, Buffer.from("suffix")]);
    const input = source.subarray(6, -6);
    const jpeg = await resizeToJpeg({ buffer: input, maxSide: 1, quality: 80 });
    expect(Buffer.isBuffer(jpeg)).toBe(true);
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await expect(getImageMetadata(jpeg)).resolves.toEqual({ width: 1, height: 1 });
    expect(input).toEqual(png);
  });

  it("lets owner cancellation preempt image work and serves the next request", async () => {
    const processor = createImageProcessor();
    await processor.encode(png, { format: "jpeg" });
    const largePng = encodePngRgba(new Uint8Array(1024 * 1024 * 4).fill(255), 1024, 1024, 1);
    const abort = new AbortController();
    const reason = new Error("owning turn cancelled");
    const timer = setTimeout(() => abort.abort(reason), 0);
    try {
      await expect(
        processor.encode(largePng, { format: "jpeg", signal: abort.signal }),
      ).rejects.toBe(reason);
    } finally {
      clearTimeout(timer);
    }
    await expect(processor.encode(png, { format: "jpeg", signal: abort.signal })).rejects.toBe(
      reason,
    );
    await expect(processor.encode(png, { format: "jpeg" })).resolves.toMatchObject({
      format: "jpeg",
      width: 1,
      height: 1,
    });
  });

  it("preserves public image validation errors across the worker boundary", async () => {
    const processor = createImageProcessor();
    await expect(
      processor.encode(Buffer.from("invalid image"), { format: "jpeg" }),
    ).rejects.toMatchObject({
      code: "RASTERMILL_UNDECODABLE",
    });
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(25_000_001, 16);
    await expect(processor.transparency(oversized)).rejects.toMatchObject({
      code: "RASTERMILL_INPUT_TOO_LARGE",
    });
  });
});
