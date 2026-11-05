import fs from "node:fs";
import path from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  openSessionArchiveReader,
  readSessionArchiveContentSync,
  readSessionArchivePrefix,
  readSessionArchiveText,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("archive compression", () => {
  it("keeps plain and compressed archives compatible with the publishing codec", async () => {
    const content = `${JSON.stringify({ type: "message", body: "archive round trip 🦞" })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const plain = path.join(dir, "plain.jsonl");
    const archive = path.join(dir, `archive.jsonl${encoded.suffix}`);
    fs.writeFileSync(plain, content);
    fs.writeFileSync(archive, encoded.bytes);
    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    expect(zstdDecompressSync(encoded.bytes).toString("utf8")).toBe(content);
    expect(readSessionArchiveContentSync(plain, Buffer.byteLength(content))).toBe(content);
    expect(await readSessionArchiveText(archive)).toBe(content);
    expect(await readSessionArchivePrefix(plain, 13)).toEqual(Buffer.from(content).subarray(0, 13));
  });

  it("reads large archives forwards and backwards without creating plaintext files", async () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archive = path.join(dir, "large.jsonl.zst");
    const frame = zstdCompressSync(Buffer.alloc(1024 * 1024, "x"));
    const bytes = Buffer.concat(Array.from({ length: 64 }, () => frame));
    fs.writeFileSync(archive, bytes);
    const reader = await openSessionArchiveReader(archive);
    const sibling = await openSessionArchiveReader(archive);
    const buffer = Buffer.alloc(17);
    try {
      expect(await reader.read(buffer, 64 * 1024 * 1024 - 5)).toBe(5);
      expect(buffer.subarray(0, 5).toString()).toBe("xxxxx");
      expect(await sibling.read(buffer, 0)).toBe(17);
      expect(await reader.read(buffer, 0)).toBe(17);
      expect(buffer.toString()).toBe("x".repeat(17));
      expect(await reader.read(buffer, 64 * 1024 * 1024)).toBe(0);
      expect((await reader.stat()).size).toBe(bytes.length);
    } finally {
      await reader.close();
    }
    try {
      expect(await sibling.read(buffer, 17)).toBe(17);
      expect(fs.readdirSync(dir)).toEqual(["large.jsonl.zst"]);
      expect(fs.readFileSync(archive)).toEqual(bytes);
    } finally {
      await sibling.close();
    }
  });

  it("reads a bounded prefix without decoding a corrupt distant suffix", async () => {
    const archive = path.join(tempDirs.make("openclaw-archive-zstd-"), "prefix.jsonl.zst");
    const frame = zstdCompressSync(Buffer.alloc(1024 * 1024, "a"), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    });
    const damaged = Buffer.from(frame);
    damaged[damaged.length - 1] = damaged.readUInt8(damaged.length - 1) ^ 1;
    fs.writeFileSync(archive, Buffer.concat([frame, damaged]));
    expect(await readSessionArchivePrefix(archive, 64)).toEqual(Buffer.alloc(64, "a"));
    await expect(readSessionArchiveText(archive)).rejects.toThrow();
  });
});
