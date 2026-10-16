import type { Worker } from "node:worker_threads";
import { encodePngRgba, readImageProbeFromHeader } from "rastermill";
import { afterAll, describe, expect, it, vi } from "vitest";
import { USER_BACKGROUND_MAX_INPUT_BYTES } from "../../packages/gateway-protocol/src/schema/background-preferences.js";

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
import { normalizeUserBackgroundImage } from "./user-background-image.js";
afterAll(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

const png = encodePngRgba(new Uint8Array([200, 40, 20, 255]), 1, 1);
describe("background raster normalization", () => {
  it("uses the real image worker to retain a static metadata-free JPEG", async () => {
    const output = await normalizeUserBackgroundImage(png.toString("base64"));
    expect(output.width).toBe(1);
    expect(output.height).toBe(1);
    expect(readImageProbeFromHeader(output.image)).toMatchObject({
      format: "jpeg",
      width: 1,
      height: 1,
    });
    expect(output.image).not.toEqual(png);
  });
  it("bounds transport bytes and pixels before decoding", async () => {
    await expect(
      normalizeUserBackgroundImage(
        "A".repeat(4 * Math.ceil(USER_BACKGROUND_MAX_INPUT_BYTES / 3) + 4),
      ),
    ).rejects.toThrow("8 MiB");
    const large = Buffer.from(png);
    large.writeUInt32BE(25_000_001, 16);
    await expect(normalizeUserBackgroundImage(large.toString("base64"))).rejects.toThrow(
      "25 megapixels",
    );
  });
  it.each(["<svg><script>alert(1)</script></svg>", "GIF89a", "not a raster"])(
    "rejects unsupported %s",
    async (text) => {
      await expect(
        normalizeUserBackgroundImage(Buffer.from(text).toString("base64")),
      ).rejects.toThrow("static JPEG");
    },
  );
  it("rejects animation containers instead of silently retaining the first frame", async () => {
    const apng = Buffer.concat([
      png.subarray(0, 33),
      Buffer.from("000000086163544c000000020000000000000000", "hex"),
      png.subarray(33),
    ]);
    await expect(normalizeUserBackgroundImage(apng.toString("base64"))).rejects.toThrow(
      "static JPEG",
    );
    const webp = Buffer.from("524946461600000057454250565038580a00000002000000000000000000", "hex");
    await expect(normalizeUserBackgroundImage(webp.toString("base64"))).rejects.toThrow(
      "static JPEG",
    );
  });
});
