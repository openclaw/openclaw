// Regression: input_file callers declare their MIME; a cosmetic filename must
// not reroute classification past an operator-configured allowlist.
import { classifyAttachmentBytes } from "@openclaw/media-core/attachment-classify";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_IMAGE_MIMES,
  extractFileContentFromBuffer,
  extractFileContentFromSource,
  extractImageContentFromSource,
  resolveInputFileLimits,
} from "./input-files.js";

describe("named attachment text decoding", () => {
  it.each(["latin1", "utf8"] as const)(
    "keeps characters in a named %s text attachment",
    async (encoding) => {
      const text = "Café notes: résumé et météo pour demain.";
      const buffer = Buffer.from(text, encoding);
      const classification = await classifyAttachmentBytes({ buffer, name: "notes.txt" });
      const result = await extractFileContentFromBuffer({
        buffer,
        filename: "notes.txt",
        classification,
        limits: resolveInputFileLimits(),
      });

      expect(result.text).toBe(text);
    },
  );

  it.each([
    { declaredMime: "text/plain; charset=windows-1251" },
    { additionalMimeHints: ["text/plain; charset=windows-1251"] },
  ])("keeps an explicit charset ahead of inferred legacy text: %j", async (mimeHints) => {
    const buffer = Buffer.from("Café notes: résumé et météo pour demain.", "latin1");
    const classification = await classifyAttachmentBytes({
      buffer,
      name: "notes.txt",
      ...mimeHints,
    });
    const result = await extractFileContentFromBuffer({
      buffer,
      filename: "notes.txt",
      classification,
      charset: "windows-1251",
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe(new TextDecoder("windows-1251").decode(buffer));
  });

  it.each([
    { declaredMime: "text/plain" },
    { declaredMime: "text/csv" },
    { declaredMime: "application/octet-stream" },
    { additionalMimeHints: ["application/octet-stream"] },
  ])("keeps characters in legacy text declared without a charset: %j", async (mimeHints) => {
    const text = "Café notes: résumé et météo pour demain.";
    const buffer = Buffer.from(text, "latin1");
    const classification = await classifyAttachmentBytes({
      buffer,
      name: "notes.txt",
      ...mimeHints,
    });
    const result = await extractFileContentFromBuffer({
      buffer,
      filename: "notes.txt",
      classification,
      mimeType: mimeHints.declaredMime,
      limits: resolveInputFileLimits(),
    });

    expect(result.text).toBe(text);
  });
});

describe("extractFileContentFromSource", () => {
  const avi = Buffer.from("524946463800000041564920" + "00".repeat(52), "hex");
  const aviSource = { type: "base64", data: avi.toString("base64"), filename: "clip.avi" } as const;

  it.each([
    { allowedMimes: ["video/x-msvideo"] },
    { allowedMimes: ["video/vnd.avi"] },
    { allowedMimes: [" VIDEO/VND.AVI; codec=DIVX "] },
    { allowedMimes: ["video/x-msvideo", "video/vnd.avi"] },
  ])(
    "matches actual AVI bytes to equivalent configured MIME values $allowedMimes",
    async ({ allowedMimes }) => {
      const classification = await classifyAttachmentBytes({ buffer: avi, name: "clip.avi" });
      expect(classification).toEqual({ mime: "video/x-msvideo", class: "video" });
      const limits = resolveInputFileLimits({ allowedMimes });
      expect(limits.allowedMimes).toEqual(new Set(["video/x-msvideo"]));

      await expect(
        extractFileContentFromSource({ source: aviSource, limits }),
      ).resolves.toMatchObject({
        filename: "clip.avi",
      });
    },
  );

  it("keeps actual AVI bytes outside the default text/PDF allowlist", async () => {
    await expect(
      extractFileContentFromSource({ source: aviSource, limits: resolveInputFileLimits() }),
    ).rejects.toThrow(/Unsupported file MIME type/);
  });

  it("rejects actual AVI bytes declared as an image under the default image allowlist", async () => {
    await expect(
      extractImageContentFromSource(
        { ...aviSource, mediaType: "image/jpeg" },
        {
          allowUrl: false,
          allowedMimes: new Set(DEFAULT_INPUT_IMAGE_MIMES),
          maxBytes: 1024,
          maxRedirects: 0,
          timeoutMs: 1000,
        },
      ),
    ).rejects.toThrow(/Unsupported image MIME type: video\//);
  });

  const legacyText = "Café notes: résumé et météo pour demain.";
  const legacyBytes = Buffer.from("Café notes", "latin1");
  const windows1252Bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]);
  const utf8Bytes = Buffer.from("café €");
  const decodingCases: [
    name: string,
    buffer: Buffer,
    mediaType: string | undefined,
    text: string,
    limits?: Parameters<typeof resolveInputFileLimits>[0],
  ][] = [
    ["inferred legacy text", Buffer.from(legacyText, "latin1"), undefined, legacyText],
    ...[
      'text/plain; charset="windows-1252"',
      'Text/Plain; Charset="WINDOWS-1252"',
      'text/plain; charset="windows\\-1252"',
      'text/plain; note="a;charset=utf-8;b"; charset=windows-1252',
      "text/plain; charset=windows-1252; charset=utf-8",
      'text/plain; charset="windows-1252"; charset=utf-8',
      "text/plain; charset=; charset=windows-1252",
      "text/plain; charset= windows-1252",
    ].map((mime): [string, Buffer, string, string] => [
      `declared ${mime}`,
      windows1252Bytes,
      mime,
      "café €",
    ]),
    ...[
      "text/plain",
      'text/plain; charset="utf-8"',
      "text/plain; charset=not-an-encoding; charset=windows-1252",
      'text/plain; charset=""; charset=windows-1252',
      "text/plain; charset =windows-1252",
    ].map((mime): [string, Buffer, string, string] => [`UTF-8 ${mime}`, utf8Bytes, mime, "café €"]),
    [
      "declared charset before inferred legacy text",
      legacyBytes,
      "text/plain; charset=windows-1251",
      new TextDecoder("windows-1251").decode(legacyBytes),
    ],
    [
      "byte-detected UTF-16 before declared charset",
      Buffer.from("\ufeffcafé €", "utf16le"),
      'text/plain; charset="windows-1252"',
      "café €",
    ],
    [
      "configured MIME synonym with charset",
      Buffer.from("name: café"),
      'text/yaml; charset="utf-8"',
      "name: café",
      { allowedMimes: ["application/yaml"] },
    ],
    ...(
      [
        ['text/plain; charset="windows-1252', "café €"],
        ['text/plain; note="a; charset=windows-1252', "caf\uFFFD \uFFFD"],
        ["plain; charset=windows-1252", "café €"],
      ] as const
    ).map(([mime, text]): [string, Buffer, string, string] => [
      `MIME recovery ${mime}`,
      windows1252Bytes,
      mime,
      text,
    ]),
  ];
  it.each(decodingCases)(
    "decodes base64 text: %s",
    async (_name, buffer, mediaType, text, limits) => {
      const result = await extractFileContentFromSource({
        source: { type: "base64", data: buffer.toString("base64"), mediaType },
        limits: resolveInputFileLimits(limits),
      });
      expect(result.text).toBe(text);
    },
  );

  it("records when input text is clamped", async () => {
    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from("VISIBLE_PREFIX|INVISIBLE_TAIL").toString("base64"),
        mediaType: "text/plain",
        filename: "long.txt",
      },
      limits: resolveInputFileLimits({ maxChars: 14 }),
    });

    expect(result).toEqual({
      filename: "long.txt",
      text: "VISIBLE_PREFIX",
      metadata: { textTruncated: true, imagesTruncated: false },
    });
  });

  it("keeps the declared MIME when the filename suggests plain text", async () => {
    const payload = JSON.stringify({ report: "q3", revenue: 12345 });
    const limits = resolveInputFileLimits({ allowedMimes: ["application/json"] });

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: Buffer.from(payload, "utf8").toString("base64"),
        mediaType: "application/json",
        filename: "notes.txt",
      },
      limits,
    });

    expect(result.text).toContain('"revenue"');
  });
});

describe("file text output limits", () => {
  const unicodeText = `\ufeff${"é".repeat(8190)}🙂\ufefftail`;
  const asciiPrefix = Buffer.alloc(16_383, "a");
  it.each([
    { name: "UTF-8 BOM only", charset: "utf-8", buffer: Buffer.from("\ufeff") },
    {
      name: "ISO-2022-JP state only",
      charset: "iso-2022-jp",
      buffer: Buffer.from([0x1b, 0x28, 0x42]),
    },
    { name: "UTF-8 Unicode and BOMs", charset: "utf-8", buffer: Buffer.from(unicodeText) },
    {
      name: "UTF-16LE Unicode and BOMs",
      charset: "utf-16le",
      buffer: Buffer.from(unicodeText, "utf16le"),
    },
    {
      name: "UTF-16BE Unicode and BOMs",
      charset: "utf-16be",
      buffer: Buffer.from(unicodeText, "utf16le").swap16(),
    },
    {
      name: "Windows-1252",
      charset: "windows-1252",
      buffer: Buffer.concat([asciiPrefix, Buffer.from([0x80, 0x21])]),
    },
    {
      name: "unsupported charset fallback",
      charset: "unsupported-encoding",
      buffer: Buffer.from(unicodeText),
      fallback: "utf-8",
    },
    {
      name: "incomplete UTF-8 at EOF",
      charset: "utf-8",
      buffer: Buffer.concat([asciiPrefix, Buffer.from([0xf0, 0x9f])]),
    },
    {
      name: "ISO-2022-JP shift state",
      charset: "iso-2022-jp",
      buffer: Buffer.concat([
        Buffer.alloc(16_382, "a"),
        Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x22, 0x1b, 0x28, 0x42]),
      ]),
    },
    {
      name: "incomplete ISO-2022-JP escape at EOF",
      charset: "iso-2022-jp",
      buffer: Buffer.concat([asciiPrefix, Buffer.from([0x1b, 0x28])]),
    },
  ])("preserves full-decoding prefixes for $name", async ({ charset, buffer, fallback }) => {
    const decoded = new TextDecoder(fallback ?? charset).decode(buffer);
    for (const maxChars of [0, 1, 8191, 8192, 16_384.9, decoded.length, Infinity]) {
      const result = await extractFileContentFromBuffer({
        buffer,
        charset,
        classification: { class: "text", mime: "text/plain" },
        limits: resolveInputFileLimits({ maxChars }),
      });
      expect(result.text, `maxChars=${maxChars}`).toBe(truncateUtf16Safe(decoded, maxChars));
      expect(Boolean(result.metadata?.textTruncated), `maxChars=${maxChars}`).toBe(
        result.text !== decoded,
      );
    }
  });
});
