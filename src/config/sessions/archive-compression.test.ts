// Round-trip and naming coverage for the archived-transcript zstd cold tier.
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("archive compression", () => {
  it.each([
    ["content reader", readSessionArchiveContentSync],
    ["cache materializer", materializeSessionArchiveForRead],
  ] as const)("bounds decompression through %s without changing the archive", (_name, read) => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "expanding.jsonl.zst");
    const bytes = zstdCompressSync(Buffer.from("x".repeat(2 * 1024 * 1024)));
    fs.writeFileSync(archivePath, bytes);

    expect(() => read(archivePath)).toThrow(/Session archive .* exceeds .* decompressed bytes/);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
  });

  it("writes compressed bytes compatible with Node zstd", () => {
    const content = `${JSON.stringify({ type: "message", body: "archive round trip" })}\n`;
    const encoded = encodeSessionArchiveContent(content);

    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    expect(zstdDecompressSync(encoded.bytes).toString("utf8")).toBe(content);
  });

  it("invalidates a materialized cache when its source archive is removed", () => {
    const encoded = encodeSessionArchiveContent("cached archive contents\n");
    expect(encoded.suffix).toBe(SESSION_ARCHIVE_ZSTD_SUFFIX);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, `removed.jsonl.deleted.2026-07-11${encoded.suffix}`);
    fs.writeFileSync(archivePath, encoded.bytes);
    const cachePath = materializeSessionArchiveForRead(archivePath);
    expect(fs.existsSync(cachePath)).toBe(true);

    fs.rmSync(archivePath);

    expect(() => materializeSessionArchiveForRead(archivePath)).toThrow();
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  it("keeps plain archives readable", () => {
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(dir, "sess.jsonl.reset.2026-07-11T00-00-00.000Z");
    fs.writeFileSync(archivePath, "plain\n", "utf8");

    expect(readSessionArchiveContentSync(archivePath)).toBe("plain\n");
  });

  it("materializes compressed archives to a stable plain JSONL cache path", () => {
    const content = `${JSON.stringify({ type: "message", body: "cold".repeat(256 * 1024) })}\n`;
    const encoded = encodeSessionArchiveContent(content);
    const dir = tempDirs.make("openclaw-archive-zstd-");
    const archivePath = path.join(
      dir,
      `sess.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(archivePath, encoded.bytes);

    const first = materializeSessionArchiveForRead(archivePath);
    const second = materializeSessionArchiveForRead(archivePath);

    expect(second).toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe(content);
    expect(first.endsWith(".jsonl")).toBe(true);
  });
});
