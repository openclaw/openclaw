// Round-trip and naming coverage for the archived-transcript zstd cold tier.
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import { decodeSessionArchiveBytes } from "./archive-decode.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("archive compression", () => {
  it("bounds synchronous full-content reads without changing the archive", () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "expanding.jsonl.zst");
    const bytes = zstdCompressSync(Buffer.from("x".repeat(2 * 1024 * 1024)));
    fs.writeFileSync(archivePath, bytes);

    expect(() => readSessionArchiveContentSync(archivePath, 1024 * 1024)).toThrow(
      /Transcript archive .* exceeds .* limit/,
    );
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
  });

  it("cleans an incomplete stream without publishing a cache entry", async () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "broken.jsonl.zst");
    fs.writeFileSync(archivePath, "not a zstd frame");
    await expect(materializeSessionArchiveForRead(archivePath)).rejects.toThrow();
    const encoded = encodeSessionArchiveContent("repaired archive");
    fs.writeFileSync(archivePath, encoded.bytes);
    const cachePath = await materializeSessionArchiveForRead(archivePath);
    expect(fs.readFileSync(cachePath, "utf8")).toBe("repaired archive");
  });

  it("decodes both plain bytes and runtime-supported compressed archive bytes", () => {
    const content = `${JSON.stringify({ type: "message", body: "archive round trip" })}\n`;
    const encoded = encodeSessionArchiveContent(content);

    expect(decodeSessionArchiveBytes(Buffer.from(content, "utf8"), false)).toBe(content);
    expect(decodeSessionArchiveBytes(encoded.bytes, encoded.suffix !== "")).toBe(content);
  });

  it("invalidates a materialized cache when its source archive is removed", async () => {
    const encoded = encodeSessionArchiveContent("cached archive contents\n");
    if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
      return;
    }
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `removed.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const cachePath = await materializeSessionArchiveForRead(archivePath);
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(archivePath);

    await expect(materializeSessionArchiveForRead(archivePath)).rejects.toThrow();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("keeps plain archives readable regardless of runtime zstd support", () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "sess.jsonl.reset.2026-07-11T00-00-00.000Z");
    fs.writeFileSync(archivePath, "plain\n", "utf8");

    expect(readSessionArchiveContentSync(archivePath)).toBe("plain\n");
  });

  it("materializes compressed archives to a stable plain JSONL cache path", async () => {
    const content = `${JSON.stringify({ type: "message", body: "cold".repeat(256 * 1024) })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(
      dir,
      `sess.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);

    const first = await materializeSessionArchiveForRead(archivePath);
    const second = await materializeSessionArchiveForRead(archivePath);

    expect(second).toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe(content);
    if (encoded.suffix === "") {
      // Plain archives pass through untouched.
      expect(first).toBe(archivePath);
    } else {
      expect(first.endsWith(".jsonl")).toBe(true);
    }
  });
});
