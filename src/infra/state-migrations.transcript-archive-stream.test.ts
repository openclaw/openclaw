import { createHash } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import { transformArchiveBytesIncrementally } from "./state-migrations.transcript-archive-stream.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("incremental transcript archive transforms", () => {
  it("keeps an unchanged zstd JSONL archive byte-identical", async () => {
    const content = `${Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({ index, text: `record-${index}-🙂` }),
    ).join("\n")}\n`;
    const source = zstdCompressSync(Buffer.from(content));
    const before = sha256(source);
    const transformed = await transformArchiveBytesIncrementally({
      bytes: source,
      encoding: "zstd",
      owner: "unchanged",
      transformLine: (line) => ({ changed: false, content: line }),
    });
    expect(transformed.changed).toBe(false);
    expect(transformed.bytes).toBe(source);
    expect(sha256(transformed.bytes)).toBe(before);
  });

  it("rewrites records incrementally while preserving order and trailing newline", async () => {
    const source = zstdCompressSync(Buffer.from('{"n":1}\n{"n":2}\n', "utf8"));
    const transformed = await transformArchiveBytesIncrementally({
      bytes: source,
      encoding: "zstd",
      owner: "changed",
      transformLine: (line) => {
        const event = JSON.parse(line) as { n: number };
        return event.n === 2
          ? { changed: true, content: JSON.stringify({ n: 2, migrated: true }) }
          : { changed: false, content: line };
      },
    });
    expect(transformed.changed).toBe(true);
    expect(zstdDecompressSync(transformed.bytes).toString("utf8")).toBe(
      '{"n":1}\n{"n":2,"migrated":true}\n',
    );
  });

  it.each(["identity", "zstd"] as const)(
    "preserves UTF-8 and record boundaries across %s chunks",
    async (encoding) => {
      const chunkSize = encoding === "identity" ? 1024 * 1024 : 16 * 1024;
      const prefix = '{"text":"';
      const first = `${prefix}${"x".repeat(chunkSize - prefix.length - 1)}🙂"}`;
      const last = '{"text":"終わり"}';
      const content = `${first}\n${last}`;
      const bytes = Buffer.from(content);
      const seen: string[] = [];
      const transformed = await transformArchiveBytesIncrementally({
        bytes: encoding === "zstd" ? zstdCompressSync(bytes) : bytes,
        encoding,
        owner: "utf8",
        transformLine: (line) => {
          seen.push((JSON.parse(line) as { text: string }).text);
          return { changed: false, content: line };
        },
      });
      expect(seen).toEqual([`${"x".repeat(chunkSize - prefix.length - 1)}🙂`, "終わり"]);
      expect(transformed.changed).toBe(false);
      expect(
        encoding === "zstd" ? zstdDecompressSync(transformed.bytes) : transformed.bytes,
      ).toEqual(bytes);
    },
  );

  it("propagates a damaged zstd stream", async () => {
    await expect(
      transformArchiveBytesIncrementally({
        bytes: Buffer.from("not a zstd archive"),
        encoding: "zstd",
        owner: "damaged",
        transformLine: (line) => ({ changed: false, content: line }),
      }),
    ).rejects.toThrow();
  });

  it("applies the media persistence transform one JSONL record at a time", async () => {
    const source = Buffer.from(
      `${JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: "attachment",
          MediaPath: "/media/example.png",
          MediaType: "image/png",
        },
      })}\n`,
    );
    const transformed = await transformArchiveBytesIncrementally({
      bytes: source,
      encoding: "identity",
      owner: "media",
      transformLine: transformMediaArchiveContent,
    });
    expect(transformed.changed).toBe(true);
    expect(JSON.parse(transformed.bytes.toString("utf8"))).toMatchObject({
      message: {
        __openclaw: { media: [{ path: "/media/example.png", contentType: "image/png" }] },
      },
    });
  });

  it.each(["identity", "zstd"] as const)(
    "removes a terminal NUL suffix from a %s archive without buffering decoded content",
    async (encoding) => {
      const content = Buffer.from('{"n":1}\n{"n":2}\0\0', "utf8");
      const source = encoding === "zstd" ? zstdCompressSync(content) : content;
      const transformed = await transformArchiveBytesIncrementally({
        bytes: source,
        encoding,
        owner: "nul-tail",
        transformLine: (line) => ({ changed: false, content: line }),
      });
      expect(transformed.changed).toBe(true);
      const decoded =
        encoding === "zstd" ? zstdDecompressSync(transformed.bytes) : transformed.bytes;
      expect(decoded.toString("utf8")).toBe('{"n":1}\n{"n":2}');
    },
  );

  it("rejects an all-NUL archive consistently with the full-content transform", async () => {
    await expect(
      transformArchiveBytesIncrementally({
        bytes: Buffer.alloc(32),
        encoding: "identity",
        owner: "all-nul",
        transformLine: (line) => ({ changed: false, content: line }),
      }),
    ).rejects.toThrow("all-nul contains no JSONL records before its terminal NUL suffix");
  });

  it("retains JSONL blank-record validation", async () => {
    const source = zstdCompressSync(Buffer.from('{"n":1}\n\n{"n":2}\n', "utf8"));
    await expect(
      transformArchiveBytesIncrementally({
        bytes: source,
        encoding: "zstd",
        owner: "blank",
        transformLine: (line) => ({ changed: false, content: line }),
      }),
    ).rejects.toThrow("blank contains a blank JSONL record at line 2");
  });
});
