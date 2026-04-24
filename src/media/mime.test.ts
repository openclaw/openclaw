import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";
import {
  detectMime,
  extensionForMime,
  imageMimeFromFormat,
  isAudioFileName,
  isVerifiedAudioSource,
  kindFromMime,
  normalizeMimeType,
  sanitizeFileName,
  sanitizeMediaMime,
} from "./mime.js";

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
  async function expectDetectedMime(params: {
    input: Parameters<typeof detectMime>[0];
    expected: string;
  }) {
    expect(await detectMime(params.input)).toBe(params.expected);
  }

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

  it.each([
    {
      name: "detects docx from buffer",
      mainMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      partPath: "/word/document.xml",
      expected: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    {
      name: "detects pptx from buffer",
      mainMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      partPath: "/ppt/presentation.xml",
      expected: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ] as const)("$name", async ({ mainMime, partPath, expected }) => {
    await expectDetectedMime({
      input: {
        buffer: await makeOoxmlZip({ mainMime, partPath }),
        filePath: "/tmp/file.bin",
      },
      expected,
    });
  });

  it.each([
    {
      name: "prefers extension mapping over generic zip",
      input: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return {
          buffer: await zip.generateAsync({ type: "nodebuffer" }),
          filePath: "/tmp/file.xlsx",
        };
      },
      expected: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      name: "uses extension mapping for JavaScript assets",
      input: async () => ({
        filePath: "/tmp/a2ui.bundle.js",
      }),
      expected: "text/javascript",
    },
  ] as const)("$name", async ({ input, expected }) => {
    await expectDetectedMime({
      input: await input(),
      expected,
    });
  });

  it("detects HTML files by extension (no magic bytes)", async () => {
    const buf = Buffer.from("<!DOCTYPE html><html><body>test</body></html>");
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/report.html" });
    expect(mime).toBe("text/html");
  });

  it("detects .htm files by extension", async () => {
    const buf = Buffer.from("<html><body>test</body></html>");
    const mime = await detectMime({ buffer: buf, filePath: "/tmp/page.htm" });
    expect(mime).toBe("text/html");
  });

  it("detects XML files by extension", async () => {
    const mime = await detectMime({ filePath: "/tmp/data.xml" });
    expect(mime).toBe("text/xml");
  });

  it("detects CSS files by extension", async () => {
    const mime = await detectMime({ filePath: "/tmp/style.css" });
    expect(mime).toBe("text/css");
  });
});

describe("extensionForMime", () => {
  function expectMimeExtensionCase(
    mime: Parameters<typeof extensionForMime>[0],
    expected: ReturnType<typeof extensionForMime>,
  ) {
    expect(extensionForMime(mime)).toBe(expected);
  }

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
    { mime: "text/html", expected: ".html" },
    { mime: "text/xml", expected: ".xml" },
    { mime: "text/css", expected: ".css" },
    { mime: "application/xml", expected: ".xml" },
    { mime: "IMAGE/JPEG", expected: ".jpg" },
    { mime: "Audio/X-M4A", expected: ".m4a" },
    { mime: "Video/QuickTime", expected: ".mov" },
    { mime: "video/unknown", expected: undefined },
    { mime: "application/x-custom", expected: undefined },
    { mime: null, expected: undefined },
    { mime: undefined, expected: undefined },
  ] as const)("maps $mime to extension", ({ mime, expected }) => {
    expectMimeExtensionCase(mime, expected);
  });
});

describe("isAudioFileName", () => {
  function expectAudioFileNameCase(fileName: string, expected: boolean) {
    expect(isAudioFileName(fileName)).toBe(expected);
  }

  it.each([
    { fileName: "voice.mp3", expected: true },
    { fileName: "voice.caf", expected: true },
    { fileName: "voice.bin", expected: false },
  ] as const)("matches audio extension for $fileName", ({ fileName, expected }) => {
    expectAudioFileNameCase(fileName, expected);
  });
});

describe("isVerifiedAudioSource", () => {
  it.each([
    { media: { kind: "audio", contentType: null }, expected: true },
    { media: { kind: "document", contentType: "audio/ogg" }, expected: false },
    { media: { kind: "document", contentType: "audio/mpeg" }, expected: false },
    { media: { kind: "document", contentType: "AUDIO/OGG" }, expected: false },
    { media: { kind: "document", contentType: "audio/ogg\r\nX-Inj: bad" }, expected: false },
    { media: { kind: "document", contentType: "audio/" }, expected: false },
    { media: { kind: "document", contentType: null }, expected: false },
    { media: { kind: "document", contentType: "application/pdf" }, expected: false },
    { media: { kind: undefined, contentType: undefined }, expected: false },
  ] as const)("classifies $media as $expected", ({ media, expected }) => {
    expect(isVerifiedAudioSource(media)).toBe(expected);
  });

  it("rejects spoofed audio Content-Type when kind is not audio (CWE-345)", () => {
    // An attacker-controlled mediaUrl response could set Content-Type:
    // audio/ogg while serving non-audio bytes. Only a caller-classified
    // kind === "audio" is trusted for PTT coercion.
    expect(isVerifiedAudioSource({ kind: "document", contentType: "audio/ogg" })).toBe(false);
    expect(isVerifiedAudioSource({ kind: undefined, contentType: "audio/opus" })).toBe(false);
  });
});

describe("sanitizeMediaMime", () => {
  it.each([
    { input: "audio/ogg", expected: "audio/ogg" },
    { input: "AUDIO/OGG", expected: "audio/ogg" },
    { input: "audio/ogg; codecs=opus", expected: "audio/ogg" },
    { input: "audio/ogg\r\nX-Inj: bad", expected: null },
    { input: "audio/ogg\nfoo", expected: null },
    { input: "audio/ogg\0nul", expected: null },
    { input: "", expected: null },
    { input: "  ", expected: null },
    { input: undefined, expected: null },
    { input: null, expected: null },
    { input: "invalid mime", expected: null },
    { input: "audio/", expected: null },
    { input: "/ogg", expected: null },
  ] as const)("sanitizes $input to $expected", ({ input, expected }) => {
    expect(sanitizeMediaMime(input)).toBe(expected);
  });

  it("preserves codecs parameter when requested", () => {
    expect(sanitizeMediaMime("audio/ogg; codecs=opus", { preserveCodecsParam: true })).toBe(
      "audio/ogg; codecs=opus",
    );
  });
});

describe("sanitizeFileName", () => {
  it.each([
    { input: "report.pdf", expected: "report.pdf" },
    { input: "voice.ogg", expected: "voice.ogg" },
    { input: "  trimmed.txt  ", expected: "trimmed.txt" },
    { input: "evil.pdf\r\nX-Inj: bad", expected: "evil.pdfX-Inj: bad" },
    { input: "name\nwith\nnewlines.txt", expected: "namewithnewlines.txt" },
    { input: "name\twith\ttab.txt", expected: "namewithtab.txt" },
    { input: "null\0byte.txt", expected: "nullbyte.txt" },
    { input: "del\x7fchar.txt", expected: "delchar.txt" },
    { input: "../../../etc/passwd", expected: ".._.._.._etc_passwd" },
    { input: "C:\\Windows\\System32", expected: "C:_Windows_System32" },
    { input: 'name"with"quotes.txt', expected: "name_with_quotes.txt" },
    { input: "invoice\u202Egnp.exe", expected: "invoicegnp.exe" },
    { input: "name\u200Ewith\u200Fmarks.txt", expected: "namewithmarks.txt" },
    { input: "iso\u2066late\u2069d.txt", expected: "isolated.txt" },
    { input: "arabic\u061Cmark.txt", expected: "arabicmark.txt" },
    { input: "", expected: "file" },
    { input: "   ", expected: "file" },
    { input: null, expected: "file" },
    { input: undefined, expected: "file" },
    { input: "\r\n\t\0", expected: "file" },
    { input: "a".repeat(200), expected: "a".repeat(128) },
    { input: "a".repeat(127) + ".txt", expected: "a".repeat(127) + "." },
    {
      input:
        "extremely-long-filename-that-exceeds-the-cap-limit-of-128-characters-for-testing-purposes-and-should-be-truncated-properly-here.pdf",
      expected:
        "extremely-long-filename-that-exceeds-the-cap-limit-of-128-characters-for-testing-purposes-and-should-be-truncated-properly-here.",
    },
  ] as const)("sanitizes $input correctly", ({ input, expected }) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it("caps very long inputs at 128 characters without quadratic-time blowup", () => {
    const longInput = "a".repeat(100000);
    const result = sanitizeFileName(longInput);
    expect(result).toBe("a".repeat(128));
    expect(result.length).toBe(128);
  });

  it("strips zero-width space (U+200B) from filename", () => {
    expect(sanitizeFileName("invoice\u200B.pdf.exe")).toBe("invoice.pdf.exe");
  });

  it("strips zero-width joiner (U+200D) from filename", () => {
    expect(sanitizeFileName("a\u200Db\u200Dc.txt")).toBe("abc.txt");
  });

  it("strips byte order mark (U+FEFF) from filename", () => {
    expect(sanitizeFileName("\uFEFFreport.pdf")).toBe("report.pdf");
  });

  it("strips soft hyphen (U+00AD) from filename", () => {
    expect(sanitizeFileName("doc\u00AD.pdf")).toBe("doc.pdf");
  });
});

describe("normalizeMimeType", () => {
  function expectNormalizedMimeCase(
    input: Parameters<typeof normalizeMimeType>[0],
    expected: ReturnType<typeof normalizeMimeType>,
  ) {
    expect(normalizeMimeType(input)).toBe(expected);
  }

  it.each([
    { input: "Audio/MP4; codecs=mp4a.40.2", expected: "audio/mp4" },
    { input: "   ", expected: undefined },
    { input: null, expected: undefined },
    { input: undefined, expected: undefined },
  ] as const)("normalizes $input", ({ input, expected }) => {
    expectNormalizedMimeCase(input, expected);
  });
});

describe("mediaKindFromMime", () => {
  function expectMediaKindCase(
    mime: Parameters<typeof mediaKindFromMime>[0],
    expected: ReturnType<typeof mediaKindFromMime>,
  ) {
    expect(mediaKindFromMime(mime)).toBe(expected);
  }

  function expectMimeKindCase(
    mime: Parameters<typeof kindFromMime>[0],
    expected: ReturnType<typeof kindFromMime>,
  ) {
    expect(kindFromMime(mime)).toBe(expected);
  }

  it.each([
    { mime: "text/plain", expected: "document" },
    { mime: "text/csv", expected: "document" },
    { mime: "text/html; charset=utf-8", expected: "document" },
    { mime: "model/gltf+json", expected: undefined },
    { mime: null, expected: undefined },
    { mime: undefined, expected: undefined },
  ] as const)("classifies $mime", ({ mime, expected }) => {
    expectMediaKindCase(mime, expected);
  });

  it.each([
    { mime: " Audio/Ogg; codecs=opus ", expected: "audio" },
    { mime: undefined, expected: undefined },
    { mime: "model/gltf+json", expected: undefined },
  ] as const)("maps kindFromMime($mime) => $expected", ({ mime, expected }) => {
    expectMimeKindCase(mime, expected);
  });
});
