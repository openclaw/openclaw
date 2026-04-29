import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

vi.mock("./image-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-ops.js")>();
  return {
    ...actual,
    hasAlphaChannel: vi.fn(async () => false),
    resizeToJpeg: vi.fn(async () => {
      throw new Error("mock image backend unavailable");
    }),
    resizeToPng: vi.fn(async () => {
      throw new Error("mock image backend unavailable");
    }),
  };
});

let loadWebMedia: typeof import("./web-media.js").loadWebMedia;
let optimizeImageToJpeg: typeof import("./web-media.js").optimizeImageToJpeg;
let fixtureRoot = "";
let pngFile = "";

beforeAll(async () => {
  ({ loadWebMedia, optimizeImageToJpeg } = await import("./web-media.js"));
  fixtureRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "web-media-fallback-"),
  );
  pngFile = path.join(fixtureRoot, "already-small.png");
  await fs.writeFile(pngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

describe("loadWebMedia image optimizer fallback", () => {
  it("sends the original image when optimization fails but the image is already under the channel cap", async () => {
    const original = await fs.readFile(pngFile);

    const result = await loadWebMedia(pngFile, {
      maxBytes: 100 * 1024 * 1024,
      localRoots: [fixtureRoot],
    });

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    expect(result.fileName).toBe("already-small.png");
    expect(result.buffer.equals(original)).toBe(true);
  });

  it("still rejects when optimization fails and the original image exceeds the channel cap", async () => {
    await expect(
      loadWebMedia(pngFile, {
        maxBytes: 1,
        localRoots: [fixtureRoot],
      }),
    ).rejects.toThrow("Failed to optimize image");
  });

  it("preserves the underlying optimizer failure as the cause", async () => {
    await expect(optimizeImageToJpeg(Buffer.from(TINY_PNG_BASE64, "base64"), 1024)).rejects.toThrow(
      /Failed to optimize image after 25 attempts \(25 failures\): mock image backend unavailable/,
    );

    await optimizeImageToJpeg(Buffer.from(TINY_PNG_BASE64, "base64"), 1024).catch(
      (err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBeInstanceOf(Error);
        expect(((err as Error).cause as Error).message).toBe("mock image backend unavailable");
      },
    );
  });
});
