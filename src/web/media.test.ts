import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { loadWebMedia } from "./media.js";

const tmpFiles: string[] = [];

afterEach(async () => {
  await Promise.all(tmpFiles.map((file) => fs.rm(file, { force: true })));
  tmpFiles.length = 0;
});

describe("web media loading", () => {
  it("compresses large local images under the provided cap", async () => {
    const buffer = await sharp({
      create: {
        width: 1600,
        height: 1600,
        channels: 3,
        background: "#ff0000",
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const file = path.join(os.tmpdir(), `clawdis-media-${Date.now()}.jpg`);
    tmpFiles.push(file);
    await fs.writeFile(file, buffer);

    const cap = Math.floor(buffer.length * 0.8);
    const result = await loadWebMedia(file, cap);

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(buffer.length);
  });

  it("sniffs mime before extension when loading local files", async () => {
    const pngBuffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const wrongExt = path.join(os.tmpdir(), `clawdis-media-${Date.now()}.bin`);
    tmpFiles.push(wrongExt);
    await fs.writeFile(wrongExt, pngBuffer);

    const result = await loadWebMedia(wrongExt, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
  });
});
