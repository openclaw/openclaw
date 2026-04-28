import { describe, expect, it } from "vitest";
import {
  buildImageResizeSideGrid,
  IMAGE_REDUCE_QUALITY_STEPS,
  isAnimatedImage,
  isAnimatedPng,
  isAnimatedWebp,
} from "./image-ops.js";

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function minimalPng(chunks: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk(
      "IHDR",
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
    ),
    ...chunks,
    pngChunk("IEND"),
  ]);
}

function riffWebp(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}

describe("buildImageResizeSideGrid", () => {
  function expectImageResizeSideGridCase(width: number, height: number, expected: number[]) {
    expect(buildImageResizeSideGrid(width, height)).toEqual(expected);
  }

  it.each([
    { width: 1200, height: 900, expected: [1200, 1000, 900, 800] },
    { width: 0, height: 0, expected: [] },
  ] as const)("builds resize side grid for %ix%i", ({ width, height, expected }) => {
    expectImageResizeSideGridCase(width, height, [...expected]);
  });
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  function expectQualityLadderCase(expectedQualityLadder: number[]) {
    expect([...IMAGE_REDUCE_QUALITY_STEPS]).toEqual(expectedQualityLadder);
  }

  it.each([
    {
      name: "keeps expected quality ladder",
      expectedQualityLadder: [85, 75, 65, 55, 45, 35],
    },
  ] as const)("$name", ({ expectedQualityLadder }) => {
    expectQualityLadderCase([...expectedQualityLadder]);
  });
});

describe("animated image detection", () => {
  it("detects APNG animation control chunks before image data", () => {
    const apng = minimalPng([
      pngChunk("acTL", Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00])),
      pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    ]);

    expect(isAnimatedPng(apng)).toBe(true);
    expect(isAnimatedImage(apng, { contentType: "image/png" })).toBe(true);
  });

  it("does not treat a static PNG as animated", () => {
    const png = minimalPng([
      pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    ]);

    expect(isAnimatedPng(png)).toBe(false);
  });

  it("detects animated WebP from VP8X animation flags", () => {
    const flags = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const webp = riffWebp([webpChunk("VP8X", flags)]);

    expect(isAnimatedWebp(webp)).toBe(true);
    expect(isAnimatedImage(webp, { contentType: "image/webp" })).toBe(true);
  });

  it("does not treat a static extended WebP as animated", () => {
    const flags = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const webp = riffWebp([webpChunk("VP8X", flags)]);

    expect(isAnimatedWebp(webp)).toBe(false);
  });
});
