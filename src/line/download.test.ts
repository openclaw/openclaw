import { describe, expect, it } from "vitest";
import { detectContentType } from "./download.js";

/**
 * Helper to build a minimal ftyp box buffer.
 * Real MPEG-4 files start with a 4-byte size, then "ftyp", then the brand.
 */
function makeFtypBuffer(brand: string): Buffer {
  // size (4 bytes) + "ftyp" (4 bytes) + brand (4 bytes) = 12 bytes minimum
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(12, 0); // box size
  buf.write("ftyp", 4, 4, "ascii"); // box type
  buf.write(brand, 8, 4, "ascii"); // major brand
  return buf;
}

describe("detectContentType", () => {
  it("detects M4A audio (iTunes AAC brand)", () => {
    const buf = makeFtypBuffer("M4A ");
    expect(detectContentType(buf)).toBe("audio/mp4");
  });

  it("detects M4B audio (audiobook brand)", () => {
    const buf = makeFtypBuffer("M4B ");
    expect(detectContentType(buf)).toBe("audio/mp4");
  });

  it("detects F4A audio (Adobe audio brand)", () => {
    const buf = makeFtypBuffer("F4A ");
    expect(detectContentType(buf)).toBe("audio/mp4");
  });

  it("detects MP4 video (isom brand)", () => {
    const buf = makeFtypBuffer("isom");
    expect(detectContentType(buf)).toBe("video/mp4");
  });

  it("detects MP4 video (mp42 brand)", () => {
    const buf = makeFtypBuffer("mp42");
    expect(detectContentType(buf)).toBe("video/mp4");
  });

  it("detects JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(detectContentType(buf)).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectContentType(buf)).toBe("image/png");
  });

  it("returns octet-stream for unknown content", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectContentType(buf)).toBe("application/octet-stream");
  });

  it("returns octet-stream for empty buffer", () => {
    const buf = Buffer.alloc(0);
    expect(detectContentType(buf)).toBe("application/octet-stream");
  });
});
