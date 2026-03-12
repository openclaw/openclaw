import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";
import {
  detectMime,
  extensionForMime,
  imageMimeFromFormat,
  isAudioFileName,
  kindFromMime,
  normalizeMimeType,
} from "./mime.js";

// Build a minimal MPEG-4 ftyp box with the specified major brand.
// Structure: [size:4][ftyp:4][major_brand:4][minor_version:4][compatible_brands:N]
function makeMp4FtypBox(majorBrand: string): Buffer {
  const size = 20; // minimum ftyp box with one compatible brand
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0); // box size
  buf.write("ftyp", 4, 4, "ascii"); // box type
  buf.write(majorBrand, 8, 4, "ascii"); // major brand
  buf.writeUInt32BE(0, 12); // minor version
  buf.write("isom", 16, 4, "ascii"); // compatible brand
  return buf;
}

async function makeOoxmlZip(opts: { mainMime: string; partPath: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override PartName="${opts.partPath}" ContentType="${opts.mainMime}.main+xml"/></Types>`,
  );
  zip.file(opts.partPath.slice(1), "<xml/>");
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("mime detection", () => {
  it.each([
    { format: "jpg", expected: "image/jpeg" },
    { format: "jpeg", expected: "image/jpeg" },
    { format: "png", expected: "image/png" },
    { format: "webp", expected: "image/webp" },
    { format: "gif", expected: "image/gif" },
    { format: "unknown", expected: undefined },
  ])("maps $format image format", ({ format, expected }) => {
    expect(imageMimeFromFormat(format)).toBe(expected);
  });

  it("detects docx from buffer", async () => {
    const buf = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partPath: "/word/document.xml",
    });
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/file.bin" });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("detects pptx from buffer", async () => {
    const buf = await makeOoxmlZip({
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      partPath: "/ppt/presentation.xml",
    });
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/file.bin" });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("prefers extension mapping over generic zip", async () => {
    const zip = new JSZip();
    zip.file("hello.txt", "hi");
    const buf = await zip.generateAsync({ type: "nodebuffer" });

    const mime = await detectMime({
      buffer: buf,
      filePath: "/tmp/file.xlsx",
    });
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("uses extension mapping for JavaScript assets", async () => {
    const mime = await detectMime({
      filePath: "/tmp/a2ui.bundle.js",
    });
    expect(mime).toBe("text/javascript");
  });

  it.each([
    // file-type already handles uppercase M4A correctly (returns audio/x-m4a)
    { brand: "M4A ", expected: "audio/x-m4a", description: "M4A audio" },
    // file-type misclassifies lowercase m4a as video/mp4; our fix corrects to audio/mp4
    { brand: "m4a ", expected: "audio/mp4", description: "M4A audio (lowercase)" },
    { brand: "M4B ", expected: "audio/mp4", description: "M4B audiobook" },
    { brand: "M4P ", expected: "audio/mp4", description: "M4P protected audio" },
    { brand: "M4R ", expected: "audio/mp4", description: "M4R ringtone" },
    { brand: "F4A ", expected: "audio/mp4", description: "F4A Flash audio" },
    { brand: "F4B ", expected: "audio/mp4", description: "F4B Flash audiobook" },
    { brand: "mp41", expected: "video/mp4", description: "MP4v1 video" },
    { brand: "isom", expected: "video/mp4", description: "ISO Base Media" },
    { brand: "avc1", expected: "video/mp4", description: "AVC video" },
  ] as const)("classifies $description by ftyp major brand", async ({ brand, expected }) => {
    const buf = makeMp4FtypBox(brand);
    const mime = await detectMime({ buffer: buf });
    expect(mime).toBe(expected);
  });
});

describe("extensionForMime", () => {
  it.each([
    { mime: "image/jpeg", expected: ".jpg" },
    { mime: "image/png", expected: ".png" },
    { mime: "image/webp", expected: ".webp" },
    { mime: "image/gif", expected: ".gif" },
    { mime: "image/heic", expected: ".heic" },
    { mime: "audio/mpeg", expected: ".mp3" },
    { mime: "audio/ogg", expected: ".ogg" },
    { mime: "audio/x-m4a", expected: ".m4a" },
    { mime: "audio/mp4", expected: ".m4a" },
    { mime: "video/mp4", expected: ".mp4" },
    { mime: "video/quicktime", expected: ".mov" },
    { mime: "application/pdf", expected: ".pdf" },
    { mime: "text/plain", expected: ".txt" },
    { mime: "text/markdown", expected: ".md" },
    { mime: "IMAGE/JPEG", expected: ".jpg" },
    { mime: "Audio/X-M4A", expected: ".m4a" },
    { mime: "Video/QuickTime", expected: ".mov" },
    { mime: "video/unknown", expected: undefined },
    { mime: "application/x-custom", expected: undefined },
    { mime: null, expected: undefined },
    { mime: undefined, expected: undefined },
  ] as const)("maps $mime to extension", ({ mime, expected }) => {
    expect(extensionForMime(mime)).toBe(expected);
  });
});

describe("isAudioFileName", () => {
  it("matches known audio extensions", () => {
    const cases = [
      { fileName: "voice.mp3", expected: true },
      { fileName: "voice.caf", expected: true },
      { fileName: "voice.bin", expected: false },
    ] as const;

    for (const testCase of cases) {
      expect(isAudioFileName(testCase.fileName)).toBe(testCase.expected);
    }
  });
});

describe("normalizeMimeType", () => {
  it.each([
    { input: "Audio/MP4; codecs=mp4a.40.2", expected: "audio/mp4" },
    { input: "   ", expected: undefined },
    { input: null, expected: undefined },
    { input: undefined, expected: undefined },
  ] as const)("normalizes $input", ({ input, expected }) => {
    expect(normalizeMimeType(input)).toBe(expected);
  });
});

describe("mediaKindFromMime", () => {
  it.each([
    { mime: "text/plain", expected: "document" },
    { mime: "text/csv", expected: "document" },
    { mime: "text/html; charset=utf-8", expected: "document" },
    { mime: "model/gltf+json", expected: undefined },
    { mime: null, expected: undefined },
    { mime: undefined, expected: undefined },
  ] as const)("classifies $mime", ({ mime, expected }) => {
    expect(mediaKindFromMime(mime)).toBe(expected);
  });

  it("normalizes MIME strings before kind classification", () => {
    expect(kindFromMime(" Audio/Ogg; codecs=opus ")).toBe("audio");
  });

  it("returns undefined for missing or unrecognized MIME kinds", () => {
    expect(kindFromMime(undefined)).toBeUndefined();
    expect(kindFromMime("model/gltf+json")).toBeUndefined();
  });
});
